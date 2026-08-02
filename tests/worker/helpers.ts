import { vi } from "vitest";

import type { Env } from "../../src/worker";

const textEncoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function makeConfiguredPasswordHash(
  password: string,
  iterations = 600_000,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", iterations, salt },
    passwordKey,
    256,
  );
  return `pbkdf2-sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(derived))}`;
}

export async function makeTestEnv(overrides: Partial<Env> = {}) {
  const password = crypto.randomUUID();
  const env = {
    ASSETS: { fetch: vi.fn() },
    LOGIN_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    PROTECTED_MEDIA: { get: vi.fn(), head: vi.fn() },
    PORTFOLIO_PASSWORD_HASH: await makeConfiguredPasswordHash(password),
    SESSION_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    ...overrides,
  } as unknown as Env;
  return { env, password };
}

export function loginRequest(password: string, origin = "https://portfolio.example"): Request {
  return new Request("https://portfolio.example/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ password }),
  });
}

export function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}
