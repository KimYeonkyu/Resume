import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import portfolioManifest from "../../config/portfolio-manifest.json";
import worker, { type Env } from "../../src/worker";

const textEncoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function runtimePasswordHash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt },
      key,
      256,
    ),
  );
  return `pbkdf2-sha256$600000$${toBase64Url(salt)}$${toBase64Url(digest)}`;
}

describe("Cloudflare Workers runtime smoke test", () => {
  it("runs the protected route in workerd with Web Crypto and configured bindings", async () => {
    const subtle = crypto.subtle as SubtleCrypto & {
      timingSafeEqual?: (left: ArrayBufferView, right: ArrayBufferView) => boolean;
    };
    expect(typeof subtle.timingSafeEqual).toBe("function");
    expect(env.PROTECTED_MEDIA).toBeDefined();
    expect(env.ASSETS).toBeDefined();
    expect((env as unknown as Env).LOGIN_RATE_LIMITER).toBeDefined();

    const response = await worker.fetch(
      new Request("https://portfolio.example/protected/mp-001"),
      env as unknown as Env,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("authenticates once and reads protected R2 media through workerd", async () => {
    const bindings = env as unknown as Env;
    const password = crypto.randomUUID();
    const testEnv: Env = {
      ASSETS: bindings.ASSETS,
      LOGIN_RATE_LIMITER: bindings.LOGIN_RATE_LIMITER,
      PORTFOLIO_PASSWORD_HASH: await runtimePasswordHash(password),
      PROTECTED_MEDIA: bindings.PROTECTED_MEDIA,
      SESSION_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
      SESSION_TTL_SECONDS: "7200",
    };
    const configuredItem = portfolioManifest.projects
      .find((project) => project.protected)
      ?.items.at(0);
    if (
      !configuredItem ||
      !("r2Key" in configuredItem) ||
      !("routeId" in configuredItem) ||
      !("contentType" in configuredItem) ||
      typeof configuredItem.r2Key !== "string" ||
      typeof configuredItem.routeId !== "string" ||
      typeof configuredItem.contentType !== "string"
    ) {
      throw new Error("Protected runtime fixture is not configured");
    }
    const mediaBytes = crypto.getRandomValues(new Uint8Array(32));
    await bindings.PROTECTED_MEDIA.put(configuredItem.r2Key, mediaBytes);

    const login = await worker.fetch(
      new Request("https://portfolio.example/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://portfolio.example",
        },
        body: JSON.stringify({ password }),
      }),
      testEnv,
    );
    expect(login.status).toBe(204);
    const cookie = login.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const session = await worker.fetch(
      new Request("https://portfolio.example/api/auth/session", {
        headers: { Cookie: cookie ?? "" },
      }),
      testEnv,
    );
    expect(await session.json()).toMatchObject({ authenticated: true });

    const media = await worker.fetch(
      new Request(`https://portfolio.example/protected/${configuredItem.routeId}`, {
        headers: { Cookie: cookie ?? "" },
      }),
      testEnv,
    );
    expect(media.status).toBe(200);
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(mediaBytes);
    expect(media.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("serves the built entrance page through the ASSETS binding", async () => {
    const response = await worker.fetch(
      new Request("https://portfolio.example/jin_kim_portfolio.html"),
      env as unknown as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).toContain("면접용 전체 포트폴리오");
    expect(html).toContain("공개 포트폴리오");
    expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//iu);
  });

  it("serves the public resume without third-party executable code", async () => {
    const response = await worker.fetch(
      new Request("https://portfolio.example/"),
      env as unknown as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//iu);
    expect(html).toContain('href="/resume.css"');
  });
});
