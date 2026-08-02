import {
  expiredSessionCookie,
  isSameOrigin,
  issueSessionCookie,
  readLoginPassword,
  validateSession,
  verifyConfiguredPassword,
} from "./security";
import { findProtectedItem, isLegacyProtectedPath, projectManifest } from "./portfolio";

export interface Env {
  ASSETS: Fetcher;
  LOGIN_RATE_LIMITER: RateLimit;
  PROTECTED_MEDIA: R2Bucket;
  PORTFOLIO_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  SESSION_TTL_SECONDS?: string;
}

const PRIVATE_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

const GENERIC_AUTH_FAILURE = JSON.stringify({ error: "Authentication failed" });
const STATIC_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "media-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return Response.json(body, { ...init, headers });
}

function genericAuthFailure(status = 400): Response {
  return new Response(GENERIC_AUTH_FAILURE, {
    status,
    headers: PRIVATE_NO_STORE_HEADERS,
  });
}

function unauthorized(): Response {
  return Response.json(
    { error: "Authentication required" },
    { status: 401, headers: PRIVATE_NO_STORE_HEADERS },
  );
}

function notFound(): Response {
  return jsonResponse({ error: "Not found" }, { status: 404 });
}

async function login(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return genericAuthFailure();
  if (!isSameOrigin(request)) return genericAuthFailure();
  const password = await readLoginPassword(request);
  if (password === null) return genericAuthFailure();
  const rateLimitKey = request.headers.get("CF-Connecting-IP")?.slice(0, 128) || "unknown";
  try {
    const rateLimit = await env.LOGIN_RATE_LIMITER.limit({ key: rateLimitKey });
    if (!rateLimit.success) return genericAuthFailure(429);
  } catch {
    return genericAuthFailure(503);
  }
  if (!(await verifyConfiguredPassword(password, env.PORTFOLIO_PASSWORD_HASH))) {
    return genericAuthFailure(401);
  }

  const setCookie = await issueSessionCookie(env.SESSION_SECRET, env.SESSION_TTL_SECONDS);
  if (!setCookie) return genericAuthFailure(503);
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "private, no-store",
      "Set-Cookie": setCookie,
    },
  });
}

async function session(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return genericAuthFailure();
  const state = await validateSession(request.headers.get("Cookie"), env.SESSION_SECRET);
  return jsonResponse(state);
}

function logout(request: Request): Response {
  if (request.method !== "POST" || !isSameOrigin(request)) return genericAuthFailure();
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "private, no-store",
      "Set-Cookie": expiredSessionCookie(),
    },
  });
}

async function projects(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return genericAuthFailure();
  const url = new URL(request.url);
  const forcePublic = url.searchParams.get("mode") === "public";
  const sessionState = forcePublic
    ? { authenticated: false }
    : await validateSession(request.headers.get("Cookie"), env.SESSION_SECRET);
  return jsonResponse(projectManifest(sessionState.authenticated), {
    headers: { Vary: "Cookie" },
  });
}

async function protectedMedia(request: Request, env: Env, pathname: string): Promise<Response> {
  const routeId = pathname.slice("/protected/".length);
  if (!/^[a-z0-9-]{1,64}$/u.test(routeId)) {
    return jsonResponse({ error: "Invalid protected media path" }, { status: 400 });
  }

  const sessionState = await validateSession(request.headers.get("Cookie"), env.SESSION_SECRET);
  if (!sessionState.authenticated) return unauthorized();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const item = findProtectedItem(routeId);
  if (!item) return jsonResponse({ error: "Protected media not found" }, { status: 404 });

  let body: ReadableStream | null = null;
  let size: number;
  if (request.method === "HEAD") {
    const object = await env.PROTECTED_MEDIA.head(item.r2Key);
    if (!object) return jsonResponse({ error: "Protected media not found" }, { status: 404 });
    size = object.size;
  } else {
    const object = await env.PROTECTED_MEDIA.get(item.r2Key);
    if (!object) return jsonResponse({ error: "Protected media not found" }, { status: 404 });
    body = object.body;
    size = object.size;
  }
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": item.contentType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (typeof size === "number") headers.set("Content-Length", String(size));
  return new Response(body, { status: 200, headers });
}

async function staticAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", STATIC_CONTENT_SECURITY_POLICY);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/auth/login") return login(request, env);
    if (pathname === "/api/auth/session") return session(request, env);
    if (pathname === "/api/auth/logout") return logout(request);
    if (pathname === "/api/projects") return projects(request, env);

    if (pathname === "/protected" || pathname === "/protected/") return notFound();

    if (pathname.startsWith("/protected/")) {
      return protectedMedia(request, env, pathname);
    }

    if (pathname === "/api" || pathname.startsWith("/api/") || isLegacyProtectedPath(pathname)) {
      return notFound();
    }

    return staticAsset(request, env);
  },
};

export default worker;
