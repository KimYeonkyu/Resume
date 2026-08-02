const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const COOKIE_NAME = "__Host-portfolio_session";
const DEFAULT_SESSION_TTL_SECONDS = 2 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 1_024;
const MIN_PASSWORD_BYTES = 16;
const MAX_PASSWORD_BYTES = 256;
const MIN_PBKDF2_ITERATIONS = 600_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const PASSWORD_DIGEST_BYTES = 32;

interface SessionPayload {
  exp: number;
  iat: number;
  v: 1;
}

export interface SessionValidation {
  authenticated: boolean;
  expiresAt?: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return toBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function constantTimeEqual(left: Uint8Array, right: Uint8Array): Promise<boolean> {
  if (left.byteLength !== right.byteLength) return false;

  const subtle = crypto.subtle;
  const runtimeTimingSafeEqual = Reflect.get(subtle, "timingSafeEqual") as unknown;
  if (typeof runtimeTimingSafeEqual === "function") {
    return runtimeTimingSafeEqual.call(subtle, left, right) as boolean;
  }

  // Standards-only runtimes do not expose Cloudflare's timingSafeEqual extension.
  // HMAC verification retains constant-time comparison inside Web Crypto.
  const context = textEncoder.encode("portfolio-password-compare-v1");
  const [candidateKey, expectedKey] = await Promise.all([
    subtle.importKey("raw", left, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    subtle.importKey("raw", right, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
  ]);
  const candidateMac = await subtle.sign("HMAC", candidateKey, context);
  return subtle.verify("HMAC", expectedKey, candidateMac, context);
}

function parsePasswordHash(configuredHash: string | undefined): {
  digest: Uint8Array;
  iterations: number;
  salt: Uint8Array;
} | null {
  if (!configuredHash) return null;
  const parts = configuredHash.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return null;
  if (!/^[1-9][0-9]{5,6}$/u.test(parts[1])) return null;
  const iterations = Number(parts[1]);
  if (iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) return null;
  const salt = fromBase64Url(parts[2]);
  const digest = fromBase64Url(parts[3]);
  if (!salt || salt.byteLength < 16 || salt.byteLength > 64) return null;
  if (!digest || digest.byteLength !== PASSWORD_DIGEST_BYTES) return null;
  return { digest, iterations, salt };
}

export async function verifyConfiguredPassword(
  password: string,
  configuredHash: string | undefined,
): Promise<boolean> {
  const parsed = parsePasswordHash(configuredHash);
  const passwordBytes = textEncoder.encode(password);
  if (
    !parsed ||
    passwordBytes.byteLength < MIN_PASSWORD_BYTES ||
    passwordBytes.byteLength > MAX_PASSWORD_BYTES
  ) {
    return false;
  }

  const passwordKey = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, [
    "deriveBits",
  ]);
  const candidate = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: parsed.iterations,
        salt: parsed.salt,
      },
      passwordKey,
      PASSWORD_DIGEST_BYTES * 8,
    ),
  );
  return constantTimeEqual(candidate, parsed.digest);
}

function validSessionSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && textEncoder.encode(secret).byteLength >= 32;
}

function getSessionTtlSeconds(configuredTtl: string | undefined): number | null {
  if (configuredTtl === undefined || configuredTtl === "") return DEFAULT_SESSION_TTL_SECONDS;
  if (!/^[1-9][0-9]*$/u.test(configuredTtl)) return null;
  const ttl = Number(configuredTtl);
  return Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= MAX_SESSION_TTL_SECONDS ? ttl : null;
}

async function importHmacKey(secret: string, usage: string[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

async function sign(payload: Uint8Array, secret: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
}

async function verifySignature(
  payload: Uint8Array,
  signature: Uint8Array,
  secret: string,
): Promise<boolean> {
  const key = await importHmacKey(secret, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, payload);
}

export async function issueSessionCookie(
  sessionSecret: string | undefined,
  configuredTtl: string | undefined,
  nowMilliseconds = Date.now(),
): Promise<string | null> {
  const ttl = getSessionTtlSeconds(configuredTtl);
  if (!validSessionSecret(sessionSecret) || ttl === null) return null;

  const issuedAt = Math.floor(nowMilliseconds / 1_000);
  const payload: SessionPayload = { exp: issuedAt + ttl, iat: issuedAt, v: 1 };
  const payloadBytes = textEncoder.encode(JSON.stringify(payload));
  const token = `v1.${toBase64Url(payloadBytes)}.${toBase64Url(await sign(payloadBytes, sessionSecret))}`;
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
  if (!validSessionSecret(sessionSecret)) return { authenticated: false };
  const token = readSessionCookie(cookieHeader);
  if (!token) return { authenticated: false };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { authenticated: false };

  const payloadBytes = fromBase64Url(parts[1]);
  const signature = fromBase64Url(parts[2]);
  if (!payloadBytes || !signature || signature.byteLength !== 32) return { authenticated: false };
  if (!(await verifySignature(payloadBytes, signature, sessionSecret))) {
    return { authenticated: false };
  }

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

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin && origin === new URL(origin).origin;
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
    const parsed: unknown = JSON.parse(textDecoder.decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).join(",") !== "password" || typeof record.password !== "string") {
      return null;
    }
    const size = textEncoder.encode(record.password).byteLength;
    return size >= MIN_PASSWORD_BYTES && size <= MAX_PASSWORD_BYTES ? record.password : null;
  } catch {
    return null;
  }
}
