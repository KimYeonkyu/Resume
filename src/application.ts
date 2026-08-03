import type { ProtectedMediaStore } from "./media-store";
import { findProtectedItem, isLegacyProtectedPath, projectManifest } from "./portfolio";
import type { LoginRateLimiter } from "./rate-limiter";
import {
  expiredSessionCookie,
  isSameOrigin,
  issueSessionCookie,
  readLoginPassword,
  type SecurityConfiguration,
  validateSecurityConfiguration,
  validateSession,
  verifyConfiguredPassword,
} from "./security";
import type { PublicAssetStore } from "./static-store";

const GENERIC_AUTH_FAILURE = JSON.stringify({ error: "Authentication failed" });
const HSTS_VALUE = "max-age=63072000; includeSubDomains";
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

const PRIVATE_JSON_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

export interface PortfolioRequestContext {
  clientIp: string;
  rawPathname: string;
}

export interface PortfolioApplication {
  handle(request: Request, context: PortfolioRequestContext): Promise<Response>;
}

export interface PortfolioApplicationOptions {
  canonicalOrigin: string;
  mediaStore: ProtectedMediaStore;
  passwordVerifier?: (password: string) => Promise<boolean>;
  rateLimiter: LoginRateLimiter;
  secrets: SecurityConfiguration;
  sessionTtlSeconds: number;
  staticStore: PublicAssetStore;
}

function validateCanonicalOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== value ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("invalid");
    }
    return parsed.origin;
  } catch {
    throw new Error("Canonical origin must be one exact HTTPS origin");
  }
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "private, no-store");
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function genericAuthFailure(status = 400): Response {
  return new Response(GENERIC_AUTH_FAILURE, { status, headers: PRIVATE_JSON_HEADERS });
}

function unauthorized(): Response {
  return jsonResponse({ error: "Authentication required" }, 401);
}

function notFound(): Response {
  return jsonResponse({ error: "Not found" }, 404);
}

function methodNotAllowed(allowed: string): Response {
  return jsonResponse({ error: "Method not allowed" }, 405, { Allow: allowed });
}

function addSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", STATIC_CONTENT_SECURITY_POLICY);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Strict-Transport-Security", HSTS_VALUE);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createPortfolioApplication(options: PortfolioApplicationOptions): PortfolioApplication {
  const canonicalOrigin = validateCanonicalOrigin(options.canonicalOrigin);
  validateSecurityConfiguration(options.secrets);
  if (
    !Number.isSafeInteger(options.sessionTtlSeconds) ||
    options.sessionTtlSeconds < 60 ||
    options.sessionTtlSeconds > 8 * 60 * 60
  ) {
    throw new Error("Session TTL is outside the supported range");
  }
  const verifyPassword =
    options.passwordVerifier ??
    ((password: string) =>
      verifyConfiguredPassword(
        password,
        options.secrets.passwordVerifier,
        options.secrets.passwordPepper,
      ));

  async function login(request: Request, context: PortfolioRequestContext): Promise<Response> {
    if (request.method !== "POST") return genericAuthFailure();
    if (!isSameOrigin(request, canonicalOrigin)) return genericAuthFailure();
    const password = await readLoginPassword(request);
    if (password === null) return genericAuthFailure();
    let allowed = false;
    try {
      allowed = options.rateLimiter.allow(context.clientIp);
    } catch {
      return genericAuthFailure(503);
    }
    if (!allowed) return genericAuthFailure(429);
    if (!(await verifyPassword(password))) return genericAuthFailure(401);

    const setCookie = await issueSessionCookie(
      options.secrets.sessionSecret,
      options.sessionTtlSeconds,
    );
    if (!setCookie) return genericAuthFailure(503);
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "private, no-store",
        "Set-Cookie": setCookie,
      },
    });
  }

  async function session(request: Request): Promise<Response> {
    if (request.method !== "GET") return genericAuthFailure();
    const state = await validateSession(
      request.headers.get("Cookie"),
      options.secrets.sessionSecret,
    );
    return jsonResponse(state);
  }

  function logout(request: Request): Response {
    if (request.method !== "POST" || !isSameOrigin(request, canonicalOrigin)) {
      return genericAuthFailure();
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "private, no-store",
        "Set-Cookie": expiredSessionCookie(),
      },
    });
  }

  async function projects(request: Request): Promise<Response> {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const forcePublic = new URL(request.url).searchParams.get("mode") === "public";
    const state = forcePublic
      ? { authenticated: false }
      : await validateSession(request.headers.get("Cookie"), options.secrets.sessionSecret);
    return jsonResponse(projectManifest(state.authenticated), 200, { Vary: "Cookie" });
  }

  async function protectedMedia(
    request: Request,
    context: PortfolioRequestContext,
  ): Promise<Response> {
    const match = /^\/protected\/([a-z0-9-]{1,64})$/u.exec(context.rawPathname);
    if (!match) return jsonResponse({ error: "Invalid protected media path" }, 400);

    const state = await validateSession(request.headers.get("Cookie"), options.secrets.sessionSecret);
    if (!state.authenticated) return unauthorized();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    const item = findProtectedItem(match[1]);
    if (!item) return jsonResponse({ error: "Protected media not found" }, 404);

    try {
      const opened = await options.mediaStore.open(item);
      const headers = new Headers({
        "Cache-Control": "private, no-store",
        "Content-Length": String(opened.size),
        "Content-Type": item.contentType,
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") {
        await opened.close();
        return new Response(null, { status: 200, headers });
      }
      return new Response(opened.createBody(), { status: 200, headers });
    } catch {
      return jsonResponse({ error: "Protected media unavailable" }, 503);
    }
  }

  async function route(request: Request, context: PortfolioRequestContext): Promise<Response> {
    const pathname = context.rawPathname;
    if (pathname === "/api/auth/login") return login(request, context);
    if (pathname === "/api/auth/session") return session(request);
    if (pathname === "/api/auth/logout") return logout(request);
    if (pathname === "/api/projects") return projects(request);

    if (pathname === "/protected" || pathname === "/protected/") return notFound();
    if (pathname.startsWith("/protected/")) return protectedMedia(request, context);
    if (pathname === "/api" || pathname.startsWith("/api/") || isLegacyProtectedPath(pathname)) {
      return notFound();
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    try {
      return (await options.staticStore.response(pathname, request.method)) ?? notFound();
    } catch {
      return jsonResponse({ error: "Public asset unavailable" }, 503);
    }
  }

  return {
    async handle(request, context) {
      return addSecurityHeaders(await route(request, context));
    },
  };
}
