import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPortfolioApplication } from "../../src/application";
import {
  createExternalProtectedMediaStore,
  type ProtectedMediaStore,
} from "../../src/media-store";
import {
  closeGracefully,
  createPortfolioHttpServer,
  listenLoopback,
} from "../../src/node-server";
import { findProtectedItem, portfolioConfiguration, type ProtectedItem } from "../../src/portfolio";
import { BoundedRateLimiter } from "../../src/rate-limiter";
import { createPublicAssetStore } from "../../src/static-store";
import {
  CANONICAL_ORIGIN,
  cookiePair,
  makeSyntheticSecrets,
  requestServer,
} from "./helpers";

interface Fixture {
  mediaBytes: Buffer;
  mediaOpen: ReturnType<typeof vi.fn<ProtectedMediaStore["open"]>>;
  password: string;
  root: string;
  server: Server;
}

const fixtures: Fixture[] = [];

async function makeFixture(options: { limiter?: BoundedRateLimiter; password?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "portfolio-node-integration-"));
  const mediaRoot = path.join(root, "private-media");
  const publicRoot = path.join(root, "public");
  await mkdir(path.join(mediaRoot, "project MP"), { recursive: true });
  await mkdir(publicRoot, { recursive: true });

  const mediaBytes = Buffer.from("synthetic protected jpeg bytes\n", "utf8");
  const sourcePath = "project MP/25.jpg";
  await writeFile(path.join(mediaRoot, sourcePath), mediaBytes);
  await writeFile(path.join(publicRoot, "index.html"), "<!doctype html><h1>public resume</h1>\n");
  await writeFile(path.join(publicRoot, "portfolio.js"), "console.log('public');\n");
  await writeFile(
    path.join(publicRoot, "public-portfolio-manifest.json"),
    JSON.stringify({ authenticated: false, projects: [] }),
  );

  const configured = findProtectedItem("mp-025");
  if (!configured) throw new Error("Expected protected fixture route mp-025");
  const item: ProtectedItem = {
    ...configured,
    sourcePath,
    sha256: createHash("sha256").update(mediaBytes).digest("hex"),
  };
  const realMediaStore = await createExternalProtectedMediaStore({
    root: mediaRoot,
    repositoryRoot: path.join(root, "repository-not-containing-media"),
    items: [item],
  });
  const mediaOpen = vi.fn<ProtectedMediaStore["open"]>(async () => realMediaStore.open(item));
  const mediaStore: ProtectedMediaStore = { open: mediaOpen };
  const staticStore = await createPublicAssetStore({
    root: publicRoot,
    allowedPaths: new Set(["index.html", "portfolio.js", "public-portfolio-manifest.json"]),
  });
  const { password, secrets } = makeSyntheticSecrets(options.password);
  const application = createPortfolioApplication({
    canonicalOrigin: CANONICAL_ORIGIN,
    mediaStore,
    rateLimiter: options.limiter ?? new BoundedRateLimiter({ limit: 10, maxKeys: 64, windowMs: 60_000 }),
    secrets,
    sessionTtlSeconds: 7_200,
    staticStore,
  });
  const server = createPortfolioHttpServer({ application, canonicalOrigin: CANONICAL_ORIGIN });
  await listenLoopback(server, { host: "127.0.0.1", port: 0 });

  const fixture = { mediaBytes, mediaOpen, password, root, server };
  fixtures.push(fixture);
  return fixture;
}

async function login(fixture: Fixture): Promise<string> {
  const response = await requestServer(fixture.server, {
    method: "POST",
    path: "/api/auth/login",
    headers: {
      "Content-Type": "application/json",
      Origin: CANONICAL_ORIGIN,
    },
    body: JSON.stringify({ password: fixture.password }),
  });
  expect(response.status).toBe(204);
  return cookiePair(response.headers["set-cookie"]);
}

afterEach(async () => {
  const pending = fixtures.splice(0);
  await Promise.all(
    pending.map(async (fixture) => {
      if (fixture.server.listening) await closeGracefully(fixture.server, { timeoutMs: 1_000 });
      await rm(fixture.root, { recursive: true, force: true });
    }),
  );
});

describe("loopback Node portfolio integration", () => {
  it("accepts an eight-character owner-selected interview password", async () => {
    const fixture = await makeFixture({ password: "V".repeat(8) });

    const response = await requestServer(fixture.server, {
      method: "POST",
      path: "/api/auth/login",
      headers: { "Content-Type": "application/json", Origin: CANONICAL_ORIGIN },
      body: JSON.stringify({ password: fixture.password }),
    });

    expect(response.status).toBe(204);
  });

  it("supports login, signed session lookup, and same-origin logout", async () => {
    const fixture = await makeFixture();

    const guest = await requestServer(fixture.server, { path: "/api/auth/session" });
    expect(guest.status).toBe(200);
    expect(JSON.parse(guest.body.toString("utf8"))).toEqual({ authenticated: false });

    const rejected = await requestServer(fixture.server, {
      method: "POST",
      path: "/api/auth/login",
      headers: { "Content-Type": "application/json", Origin: CANONICAL_ORIGIN },
      body: JSON.stringify({ password: `${fixture.password}wrong` }),
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers["set-cookie"]).toBeUndefined();

    const cookie = await login(fixture);
    const setCookie = String(
      (
        await requestServer(fixture.server, {
          method: "POST",
          path: "/api/auth/login",
          headers: { "Content-Type": "application/json", Origin: CANONICAL_ORIGIN },
          body: JSON.stringify({ password: fixture.password }),
        })
      ).headers["set-cookie"],
    );
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain=");

    const authenticated = await requestServer(fixture.server, {
      path: "/api/auth/session",
      headers: { Cookie: cookie },
    });
    expect(JSON.parse(authenticated.body.toString("utf8"))).toMatchObject({ authenticated: true });

    const logout = await requestServer(fixture.server, {
      method: "POST",
      path: "/api/auth/logout",
      headers: { Cookie: cookie, Origin: CANONICAL_ORIGIN },
    });
    expect(logout.status).toBe(204);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");

    const loggedOut = await requestServer(fixture.server, {
      path: "/api/auth/session",
      headers: { Cookie: cookiePair(logout.headers["set-cookie"]) },
    });
    expect(JSON.parse(loggedOut.body.toString("utf8"))).toEqual({ authenticated: false });
  });

  it("returns a guest-safe manifest with no protected locators", async () => {
    const fixture = await makeFixture();
    const response = await requestServer(fixture.server, { path: "/api/projects?mode=public" });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Cookie");
    const body = JSON.parse(response.body.toString("utf8")) as {
      authenticated: boolean;
      projects: Array<{ id: string; items: Array<Record<string, unknown>> }>;
    };
    expect(body.authenticated).toBe(false);
    const serialized = JSON.stringify(body);
    for (const project of portfolioConfiguration.projects) {
      project.items.forEach((item, index) => {
        const protectedItem = project.protected || ("protected" in item && item.protected === true);
        if (!protectedItem) return;
        expect(body.projects.find((candidate) => candidate.id === project.id)?.items[index]).toMatchObject({
          locked: true,
          type: "locked",
        });
        expect(serialized).not.toContain(item.sourcePath);
        if ("routeId" in item) expect(serialized).not.toContain(item.routeId);
        if ("sha256" in item) expect(serialized).not.toContain(item.sha256);
      });
    }
    expect(serialized).not.toContain("/protected/");
  });

  it.each(["GET", "HEAD"])(
    "rejects unauthenticated %s media before any protected file open",
    async (method) => {
      const fixture = await makeFixture();
      const response = await requestServer(fixture.server, {
        method,
        path: "/protected/mp-025",
      });

      expect(response.status).toBe(401);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(fixture.mediaOpen).not.toHaveBeenCalled();
    },
  );

  it("streams authenticated bytes and returns verified metadata for HEAD", async () => {
    const fixture = await makeFixture();
    const cookie = await login(fixture);

    const media = await requestServer(fixture.server, {
      path: "/protected/mp-025",
      headers: { Cookie: cookie },
    });
    expect(media.status).toBe(200);
    expect(media.body).toEqual(fixture.mediaBytes);
    expect(media.headers["content-length"]).toBe(String(fixture.mediaBytes.byteLength));
    expect(media.headers["content-type"]).toBe("image/jpeg");
    expect(media.headers["cache-control"]).toBe("private, no-store");
    expect(media.headers["cross-origin-resource-policy"]).toBe("same-origin");

    const head = await requestServer(fixture.server, {
      method: "HEAD",
      path: "/protected/mp-025",
      headers: { Cookie: cookie },
    });
    expect(head.status).toBe(200);
    expect(head.body.byteLength).toBe(0);
    expect(head.headers["content-length"]).toBe(String(fixture.mediaBytes.byteLength));
    expect(fixture.mediaOpen).toHaveBeenCalledTimes(2);
  });

  it.each([
    "/protected/%2e%2e/mp-025",
    "/protected/mp-025%2fextra",
    "/protected/%5cetc",
    "/protected/%00",
    "/protected/mp-025/extra",
    "/protected/%252e%252e",
  ])("rejects traversal-like route %s without opening media", async (route) => {
    const fixture = await makeFixture();
    const cookie = await login(fixture);
    fixture.mediaOpen.mockClear();

    const response = await requestServer(fixture.server, { path: route, headers: { Cookie: cookie } });

    expect([400, 404]).toContain(response.status);
    expect(fixture.mediaOpen).not.toHaveBeenCalled();
  });

  it("fails closed on proxy/origin mismatch before rate-limit or password verification", async () => {
    const limiter = new BoundedRateLimiter({ limit: 10, maxKeys: 64, windowMs: 60_000 });
    const allow = vi.spyOn(limiter, "allow");
    const fixture = await makeFixture({ limiter });
    const body = JSON.stringify({ password: fixture.password });

    const badOrigin = await requestServer(fixture.server, {
      method: "POST",
      path: "/api/auth/login",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body,
    });
    expect(badOrigin.status).toBe(400);
    expect(allow).not.toHaveBeenCalled();

    const badProto = await requestServer(fixture.server, {
      method: "POST",
      path: "/api/auth/login",
      headers: {
        "Content-Type": "application/json",
        Origin: CANONICAL_ORIGIN,
        "X-Forwarded-Proto": "http",
      },
      body,
    });
    expect(badProto.status).toBe(421);
    expect(allow).not.toHaveBeenCalled();

    const badHost = await requestServer(fixture.server, {
      method: "POST",
      path: "/api/auth/login",
      headers: { "Content-Type": "application/json", Host: "preview.example", Origin: CANONICAL_ORIGIN },
      body,
    });
    expect(badHost.status).toBe(421);
    expect(allow).not.toHaveBeenCalled();
  });

  it("rate-limits before password verification", async () => {
    const limiter = new BoundedRateLimiter({ limit: 0, maxKeys: 64, windowMs: 60_000 });
    const fixture = await makeFixture({ limiter });
    const response = await requestServer(fixture.server, {
      method: "POST",
      path: "/api/auth/login",
      headers: { "Content-Type": "application/json", Origin: CANONICAL_ORIGIN },
      body: JSON.stringify({ password: fixture.password }),
    });

    expect(response.status).toBe(429);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("serves only allowlisted public files with safe headers and HEAD semantics", async () => {
    const fixture = await makeFixture();
    const page = await requestServer(fixture.server, { path: "/" });

    expect(page.status).toBe(200);
    expect(page.body.toString("utf8")).toContain("public resume");
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["strict-transport-security"]).toContain("max-age=");

    const head = await requestServer(fixture.server, { method: "HEAD", path: "/portfolio.js" });
    expect(head.status).toBe(200);
    expect(head.body.byteLength).toBe(0);
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);

    const missing = await requestServer(fixture.server, { path: "/not-allowlisted.txt" });
    expect(missing.status).toBe(404);
    const traversal = await requestServer(fixture.server, { path: "/%2e%2e/private-media/project%20MP/25.jpg" });
    expect([400, 404]).toContain(traversal.status);
    expect(fixture.mediaOpen).not.toHaveBeenCalled();
  });

  it("provides loopback health and closes gracefully", async () => {
    const fixture = await makeFixture();
    const health = await requestServer(fixture.server, {
      path: "/healthz",
      proxyHeaders: false,
      headers: { Host: "127.0.0.1" },
    });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body.toString("utf8"))).toEqual({ status: "ok" });

    await closeGracefully(fixture.server, { timeoutMs: 1_000 });
    expect(fixture.server.listening).toBe(false);
  });
});
