import { describe, expect, it } from "vitest";

import { deriveProxyRequestContext, validateLoopbackHost } from "../../src/node-server";
import { BoundedRateLimiter } from "../../src/rate-limiter";
import { loadRuntimeSettings } from "../../src/runtime-config";
import { validateSecurityConfiguration } from "../../src/security";
import { CANONICAL_ORIGIN, makeSyntheticSecrets } from "./helpers";

describe("startup security configuration", () => {
  it("accepts canonical versioned synthetic secrets", () => {
    const { secrets } = makeSyntheticSecrets();
    expect(() => validateSecurityConfiguration(secrets)).not.toThrow();
  });

  it.each([
    ["passwordVerifier", "sha256-v1$legacy"],
    ["passwordVerifier", `hmac-sha256-v1$${"A".repeat(42)}`],
    ["passwordPepper", "pepper-v2$malformed"],
    ["passwordPepper", `pepper-v1$${"_".repeat(43)}`],
    ["sessionSecret", "too-short"],
    ["sessionSecret", `session-v2$${"A".repeat(43)}`],
  ] as const)("rejects malformed %s values", (key, value) => {
    const { secrets } = makeSyntheticSecrets();
    expect(() => validateSecurityConfiguration({ ...secrets, [key]: value })).toThrow();
  });
});

describe("runtime secret loading", () => {
  it("supports explicit synthetic environment secrets outside production", async () => {
    const { secrets } = makeSyntheticSecrets();
    const settings = await loadRuntimeSettings({
      cwd: "/tmp/portfolio-checkout",
      env: {
        NODE_ENV: "test",
        PORTFOLIO_CANONICAL_ORIGIN: CANONICAL_ORIGIN,
        PORTFOLIO_PASSWORD_PEPPER: secrets.passwordPepper,
        PORTFOLIO_PASSWORD_VERIFIER: secrets.passwordVerifier,
        PORTFOLIO_PROTECTED_MEDIA_ROOT: "/tmp/private-media",
        PORTFOLIO_SECRET_SOURCE: "environment",
        SESSION_SECRET: secrets.sessionSecret,
      },
    });

    expect(settings.secrets).toEqual(secrets);
    expect(settings.bindHost).toBe("127.0.0.1");
    expect(settings.publicRoot).toBe("/tmp/portfolio-checkout/dist");
  });

  it("refuses environment-sourced production secrets", async () => {
    const { secrets } = makeSyntheticSecrets();
    await expect(
      loadRuntimeSettings({
        cwd: "/tmp/portfolio-checkout",
        env: {
          NODE_ENV: "production",
          PORTFOLIO_CANONICAL_ORIGIN: CANONICAL_ORIGIN,
          PORTFOLIO_PASSWORD_PEPPER: secrets.passwordPepper,
          PORTFOLIO_PASSWORD_VERIFIER: secrets.passwordVerifier,
          PORTFOLIO_PROTECTED_MEDIA_ROOT: "/tmp/private-media",
          PORTFOLIO_SECRET_SOURCE: "environment",
          SESSION_SECRET: secrets.sessionSecret,
        },
      }),
    ).rejects.toThrow(/production|Keychain/iu);
  });

  it("loads production secrets through named Keychain entries", async () => {
    const { secrets } = makeSyntheticSecrets();
    const values = new Map([
      ["com.jinkim.portfolio.password-verifier", secrets.passwordVerifier],
      ["com.jinkim.portfolio.password-pepper", secrets.passwordPepper],
      ["com.jinkim.portfolio.session-secret", secrets.sessionSecret],
    ]);
    const requested: string[] = [];
    const settings = await loadRuntimeSettings({
      cwd: "/tmp/portfolio-checkout",
      env: {
        NODE_ENV: "production",
        PORTFOLIO_CANONICAL_ORIGIN: CANONICAL_ORIGIN,
        PORTFOLIO_KEYCHAIN_ACCOUNT: "portfolio-runtime",
        PORTFOLIO_PROTECTED_MEDIA_ROOT: "/tmp/private-media",
      },
      keychainReader: async (account, service) => {
        expect(account).toBe("portfolio-runtime");
        requested.push(service);
        const value = values.get(service);
        if (!value) throw new Error("missing synthetic Keychain value");
        return value;
      },
    });

    expect(settings.secrets).toEqual(secrets);
    expect(requested).toEqual([...values.keys()]);
  });
});

describe("bounded in-memory login limiter", () => {
  it("enforces a fixed window while bounding remembered client keys", () => {
    const limiter = new BoundedRateLimiter({ limit: 2, maxKeys: 3, windowMs: 1_000 });
    expect(limiter.allow("192.0.2.1", 0)).toBe(true);
    expect(limiter.allow("192.0.2.1", 1)).toBe(true);
    expect(limiter.allow("192.0.2.1", 2)).toBe(false);
    expect(limiter.allow("192.0.2.2", 3)).toBe(true);
    expect(limiter.allow("192.0.2.3", 4)).toBe(true);
    expect(limiter.allow("192.0.2.4", 5)).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(3);
    expect(limiter.allow("192.0.2.1", 1_001)).toBe(true);
  });
});

describe("loopback and reverse-proxy boundary", () => {
  it.each(["127.0.0.1", "::1"])("accepts the literal loopback bind host %s", (host) => {
    expect(() => validateLoopbackHost(host)).not.toThrow();
  });

  it.each(["0.0.0.0", "::", "localhost", "192.0.2.2"])(
    "rejects a non-literal-loopback bind host %s",
    (host) => {
      expect(() => validateLoopbackHost(host)).toThrow(/loopback/iu);
    },
  );

  it("derives canonical HTTPS context only from the loopback proxy", () => {
    expect(
      deriveProxyRequestContext(
        {
          host: "portfolio.example",
          "x-forwarded-for": "198.51.100.4",
          "x-forwarded-proto": "https",
        },
        "127.0.0.1",
        CANONICAL_ORIGIN,
      ),
    ).toEqual({ clientIp: "198.51.100.4" });

    expect(() =>
      deriveProxyRequestContext(
        { host: "portfolio.example", "x-forwarded-proto": "https" },
        "203.0.113.9",
        CANONICAL_ORIGIN,
      ),
    ).toThrow(/loopback|proxy/iu);
    expect(() =>
      deriveProxyRequestContext(
        { host: "portfolio.example", "x-forwarded-proto": "https,http" },
        "127.0.0.1",
        CANONICAL_ORIGIN,
      ),
    ).toThrow(/proto|proxy/iu);
    expect(() =>
      deriveProxyRequestContext(
        { host: "preview.example", "x-forwarded-proto": "https" },
        "127.0.0.1",
        CANONICAL_ORIGIN,
      ),
    ).toThrow(/host|origin/iu);
  });
});
