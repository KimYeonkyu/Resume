import { createHmac, timingSafeEqual } from "node:crypto";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const COOKIE_NAME = "__Host-portfolio_session";
const DEFAULT_SESSION_TTL_SECONDS = 2 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 1_024;
const MIN_PASSWORD_BYTES = 8;
const MAX_PASSWORD_BYTES = 256;
const SECRET_BYTES = 32;

interface SessionPayload {
  exp: number;
  iat: number;
  v: 1;
}

export interface SecurityConfiguration {
  passwordPepper: string;
  passwordVerifier: string;
  sessionSecret: string;
}

export interface SessionValidation {
  authenticated: boolean;
  expiresAt?: number;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.toString("base64url") === value ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

function parseEnvelope(value: string | undefined, prefix: string): Uint8Array | null {
  if (typeof value !== "string") return null;
  const parts = value.split("$");
  if (parts.length !== 2 || parts[0] !== prefix) return null;
  const decoded = fromBase64Url(parts[1]);
  return decoded?.byteLength === SECRET_BYTES ? decoded : null;
}

function parsePasswordVerifier(value: string | undefined): Uint8Array | null {
  return parseEnvelope(value, "hmac-sha256-v1");
}

function parsePasswordPepper(value: string | undefined): Uint8Array | null {
  return parseEnvelope(value, "pepper-v1");
}

function parseSessionSecret(value: string | undefined): Uint8Array | null {
  return parseEnvelope(value, "session-v1");
}

export function validateSecurityConfiguration(configuration: SecurityConfiguration): void {
  if (!parsePasswordVerifier(configuration.passwordVerifier)) {
    throw new Error("PORTFOLIO_PASSWORD_VERIFIER is malformed");
  }
  if (!parsePasswordPepper(configuration.passwordPepper)) {
    throw new Error("PORTFOLIO_PASSWORD_PEPPER is malformed");
  }
  if (!parseSessionSecret(configuration.sessionSecret)) {
    throw new Error("SESSION_SECRET is malformed");
  }
}

export async function verifyConfiguredPassword(
  password: string,
  configuredVerifier: string | undefined,
  configuredPepper: string | undefined,
): Promise<boolean> {
  const expectedVerifier = parsePasswordVerifier(configuredVerifier);
  const pepper = parsePasswordPepper(configuredPepper);
  const passwordBytes = textEncoder.encode(password);
  if (
    !expectedVerifier ||
    !pepper ||
    passwordBytes.byteLength < MIN_PASSWORD_BYTES ||
    passwordBytes.byteLength > MAX_PASSWORD_BYTES
  ) {
    return false;
  }

  const candidate = createHmac("sha256", pepper).update(passwordBytes).digest();
  return timingSafeEqual(candidate, expectedVerifier);
}

function getSessionTtlSeconds(configuredTtl: string | number | undefined): number | null {
  if (configuredTtl === undefined || configuredTtl === "") return DEFAULT_SESSION_TTL_SECONDS;
  const value = typeof configuredTtl === "number" ? String(configuredTtl) : configuredTtl;
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const ttl = Number(value);
  return Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= MAX_SESSION_TTL_SECONDS ? ttl : null;
}

function sign(payload: Uint8Array, secret: Uint8Array): Uint8Array {
  return createHmac("sha256", secret).update(payload).digest();
}

export async function issueSessionCookie(
  sessionSecret: string | undefined,
  configuredTtl: string | number | undefined,
  nowMilliseconds = Date.now(),
): Promise<string | null> {
  const secret = parseSessionSecret(sessionSecret);
  const ttl = getSessionTtlSeconds(configuredTtl);
  if (!secret || ttl === null) return null;

  const issuedAt = Math.floor(nowMilliseconds / 1_000);
  const payload: SessionPayload = { exp: issuedAt + ttl, iat: issuedAt, v: 1 };
  const payloadBytes = textEncoder.encode(JSON.stringify(payload));
  const token = `v1.${toBase64Url(payloadBytes)}.${toBase64Url(sign(payloadBytes, secret))}`;
  const expires = new Date((issuedAt + ttl) * 1_000).toUTCString();
  return `${COOKIE_NAME}=${token}; Max-Age=${ttl}; Expires=${expires}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`))
    .map((part) => part.slice(COOKIE_NAME.length + 1));
  return values.length === 1 && values[0] ? values[0] : null;
}

function parseSessionPayload(bytes: Uint8Array): SessionPayload | null {
  try {
    const value: unknown = JSON.parse(textDecoder.decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    if (Object.keys(payload).sort().join(",") !== "exp,iat,v") return null;
    if (payload.v !== 1) return null;
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return null;
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export async function validateSession(
  cookieHeader: string | null,
  sessionSecret: string | undefined,
  nowMilliseconds = Date.now(),
): Promise<SessionValidation> {
  const secret = parseSessionSecret(sessionSecret);
  if (!secret) return { authenticated: false };
  const token = readSessionCookie(cookieHeader);
  if (!token) return { authenticated: false };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { authenticated: false };

  const payloadBytes = fromBase64Url(parts[1]);
  const signature = fromBase64Url(parts[2]);
  if (!payloadBytes || !signature || signature.byteLength !== SECRET_BYTES) {
    return { authenticated: false };
  }
  const expected = sign(payloadBytes, secret);
  if (!timingSafeEqual(expected, signature)) return { authenticated: false };

  const payload = parseSessionPayload(payloadBytes);
  if (!payload) return { authenticated: false };
  const now = Math.floor(nowMilliseconds / 1_000);
  if (payload.exp <= now || payload.iat > now + 60) return { authenticated: false };
  if (payload.exp - payload.iat <= 0 || payload.exp - payload.iat > MAX_SESSION_TTL_SECONDS) {
    return { authenticated: false };
  }
  return { authenticated: true, expiresAt: payload.exp * 1_000 };
}

export function expiredSessionCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function isSameOrigin(request: Request, canonicalOrigin: string): boolean {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== canonicalOrigin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin;
  } catch {
    return false;
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) return null;
    if (Number(contentLength) > MAX_LOGIN_BODY_BYTES) return null;
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_LOGIN_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readLoginPassword(request: Request): Promise<string | null> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const body = await readBoundedBody(request);
  if (!body) return null;
  try {
    const text = textDecoder.decode(body);
    const match = /^\s*\{\s*"password"\s*:\s*("(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9A-Fa-f]{4})*")\s*\}\s*$/u.exec(
      text,
    );
    if (!match) return null;
    const password: unknown = JSON.parse(match[1]);
    if (typeof password !== "string") return null;
    const size = textEncoder.encode(password).byteLength;
    return size >= MIN_PASSWORD_BYTES && size <= MAX_PASSWORD_BYTES ? password : null;
  } catch {
    return null;
  }
}
