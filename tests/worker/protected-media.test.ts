import { describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../../src/worker";
import { cookiePair, loginRequest, makeTestEnv } from "./helpers";

function makeEnv() {
  return {
    ASSETS: { fetch: vi.fn() },
    PROTECTED_MEDIA: { get: vi.fn(), head: vi.fn() },
  } as unknown as Env;
}

describe("protected media authorization", () => {
  it.each(["GET", "HEAD"])(
    "rejects an unauthenticated %s protected-media request without reading R2",
    async (method) => {
      const env = makeEnv();

      const response = await worker.fetch(
        new Request("https://portfolio.example/protected/mp-001", { method }),
        env,
      );

      expect(response.status).toBe(401);
      expect(env.PROTECTED_MEDIA.get).not.toHaveBeenCalled();
      expect(env.PROTECTED_MEDIA.head).not.toHaveBeenCalled();
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    },
  );

  it("uses an R2 metadata read for an authenticated HEAD request", async () => {
    const { env, password } = await makeTestEnv();
    const login = await worker.fetch(loginRequest(password), env);
    const cookie = cookiePair(login.headers.get("Set-Cookie") ?? "");
    const head = vi.mocked(env.PROTECTED_MEDIA.head);
    head.mockResolvedValue({ size: 123 } as R2Object);

    const response = await worker.fetch(
      new Request("https://portfolio.example/protected/mp-001", {
        method: "HEAD",
        headers: { Cookie: cookie },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(head).toHaveBeenCalledOnce();
    expect(env.PROTECTED_MEDIA.get).not.toHaveBeenCalled();
    expect(response.headers.get("Content-Length")).toBe("123");
  });

  it.each([
    "/project%20MP",
    "/project%20MP/24.jpg",
    "/project%20DM",
    "/project%20DM/sheet_arad01.jpg",
    "/MP.pdf",
    "/DM.pdf",
  ])("denies the legacy protected source route %s before static assets", async (path) => {
    const env = makeEnv();

    const response = await worker.fetch(new Request(`https://portfolio.example${path}`), env);

    expect(response.status).toBe(404);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(env.PROTECTED_MEDIA.get).not.toHaveBeenCalled();
  });

  it.each(["/api/unknown", "/protected", "/protected/"])(
    "does not let a reserved route fall through to static assets: %s",
    async (path) => {
      const env = makeEnv();

      const response = await worker.fetch(new Request(`https://portfolio.example${path}`), env);

      expect(response.status).toBe(404);
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
      expect(env.PROTECTED_MEDIA.get).not.toHaveBeenCalled();
    },
  );
});
