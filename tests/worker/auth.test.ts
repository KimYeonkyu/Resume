import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../../src/worker";
import {
  cookiePair,
  loginRequest,
  makeConfiguredPasswordHash,
  makeTestEnv,
} from "./helpers";

afterEach(() => {
  vi.useRealTimers();
});

describe("portfolio authentication", () => {
  it("does not issue a cookie for a wrong password and does for the configured password", async () => {
    const { env, password } = await makeTestEnv();

    const rejected = await worker.fetch(loginRequest(crypto.randomUUID()), env);
    expect(rejected.status).toBe(401);
    expect(rejected.headers.has("Set-Cookie")).toBe(false);

    const accepted = await worker.fetch(loginRequest(password), env);
    expect(accepted.status).toBe(204);
    const setCookie = accepted.headers.get("Set-Cookie");
    if (!setCookie) throw new Error("Successful login did not issue a session cookie");
    const [nameValue, ...attributeParts] = setCookie.split(";");
    if (
      !/^__Host-portfolio_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(
        nameValue,
      )
    ) {
      throw new Error("Successful login issued a malformed session cookie");
    }
    const attributes = attributeParts.join(";");
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("Secure");
    expect(attributes).toContain("SameSite=Strict");
    expect(attributes).toContain("Path=/");
    expect(attributes).toContain("Max-Age=7200");
    expect(attributes).not.toContain("Domain=");
  });

  it("fails closed when the configured PBKDF2 work factor is below policy", async () => {
    const password = crypto.randomUUID();
    const weakConfiguredHash = await makeConfiguredPasswordHash(password, 100_000);
    const { env } = await makeTestEnv({ PORTFOLIO_PASSWORD_HASH: weakConfiguredHash });

    const response = await worker.fetch(loginRequest(password), env);

    expect(response.status).toBe(401);
    expect(response.headers.has("Set-Cookie")).toBe(false);
  });

  it("rejects a configured password that is too short for the deployment policy", async () => {
    const shortPassword = crypto.randomUUID().slice(0, 8);
    const configuredHash = await makeConfiguredPasswordHash(shortPassword);
    const { env } = await makeTestEnv({ PORTFOLIO_PASSWORD_HASH: configuredHash });

    const response = await worker.fetch(loginRequest(shortPassword), env);

    expect(response.status).toBe(400);
    expect(response.headers.has("Set-Cookie")).toBe(false);
  });

  it("rejects a rate-limited login attempt before issuing a session", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const { env, password } = await makeTestEnv({
      LOGIN_RATE_LIMITER: { limit } as RateLimit,
    });
    const request = loginRequest(password);
    request.headers.set("CF-Connecting-IP", "192.0.2.10");

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(429);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(await response.text()).toBe(JSON.stringify({ error: "Authentication failed" }));
    expect(limit).toHaveBeenCalledOnce();
    expect(limit).toHaveBeenCalledWith({ key: "192.0.2.10" });
  });

  it("recognizes a valid cookie and rejects expired or tampered session state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const { env, password } = await makeTestEnv();
    const login = await worker.fetch(loginRequest(password), env);
    const issuedCookie = cookiePair(login.headers.get("Set-Cookie") ?? "");

    const valid = await worker.fetch(
      new Request("https://portfolio.example/api/auth/session", {
        headers: { Cookie: issuedCookie },
      }),
      env,
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ authenticated: true });

    const finalCharacter = issuedCookie.at(-1);
    const tamperedCookie = `${issuedCookie.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
    const tampered = await worker.fetch(
      new Request("https://portfolio.example/api/auth/session", {
        headers: { Cookie: tamperedCookie },
      }),
      env,
    );
    expect(await tampered.json()).toEqual({ authenticated: false });

    vi.advanceTimersByTime(7_200_001);
    const expired = await worker.fetch(
      new Request("https://portfolio.example/api/auth/session", {
        headers: { Cookie: issuedCookie },
      }),
      env,
    );
    expect(await expired.json()).toEqual({ authenticated: false });
  });

  it.each(["59", "28801", "not-a-duration"])(
    "fails closed for an out-of-policy session lifetime: %s",
    async (configuredTtl) => {
      const { env, password } = await makeTestEnv({ SESSION_TTL_SECONDS: configuredTtl });

      const response = await worker.fetch(loginRequest(password), env);

      expect(response.status).toBe(503);
      expect(response.headers.has("Set-Cookie")).toBe(false);
    },
  );

  it("expires the session cookie on same-origin logout", async () => {
    const { env } = await makeTestEnv();
    const response = await worker.fetch(
      new Request("https://portfolio.example/api/auth/logout", {
        method: "POST",
        headers: { Origin: "https://portfolio.example" },
      }),
      env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-portfolio_session=");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).toContain("Secure");
    expect(response.headers.get("Set-Cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("Set-Cookie")).toContain("Path=/");
    expect(response.headers.get("Set-Cookie")).not.toContain("Domain=");

    const expiredCookie = cookiePair(response.headers.get("Set-Cookie") ?? "");
    const session = await worker.fetch(
      new Request("https://portfolio.example/api/auth/session", {
        headers: { Cookie: expiredCookie },
      }),
      env,
    );
    expect(await session.json()).toEqual({ authenticated: false });

    const protectedResponse = await worker.fetch(
      new Request("https://portfolio.example/protected/mp-001", {
        headers: { Cookie: expiredCookie },
      }),
      env,
    );
    expect(protectedResponse.status).toBe(401);
    expect(env.PROTECTED_MEDIA.get).not.toHaveBeenCalled();
  });

  it("uses one generic rejection for malformed, oversized, and cross-origin login requests", async () => {
    const { env } = await makeTestEnv();
    const requests = [
      new Request("https://portfolio.example/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://portfolio.example" },
        body: "{",
      }),
      new Request("https://portfolio.example/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://portfolio.example" },
        body: JSON.stringify({ password: crypto.randomUUID().repeat(64) }),
      }),
      loginRequest(crypto.randomUUID(), "https://other.example"),
    ];

    const responses = await Promise.all(requests.map((request) => worker.fetch(request, env)));
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(new Set(await Promise.all(responses.map((response) => response.text()))).size).toBe(1);
    expect(responses.every((response) => !response.headers.has("Set-Cookie"))).toBe(true);
    expect(responses.every((response) => !response.headers.has("Access-Control-Allow-Origin"))).toBe(
      true,
    );
  });

  it("rejects duplicate session cookie names fail-closed", async () => {
    const { env, password } = await makeTestEnv();
    const login = await worker.fetch(loginRequest(password), env);
    const issuedCookie = cookiePair(login.headers.get("Set-Cookie") ?? "");
    const response = await worker.fetch(
      new Request("https://portfolio.example/api/auth/session", {
        headers: { Cookie: `${issuedCookie}; ${issuedCookie}` },
      }),
      env,
    );

    expect(await response.json()).toEqual({ authenticated: false });
  });
});
