import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";

import type { PortfolioApplication } from "./application";

class ProxyBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyBoundaryError";
  }
}

function singleHeader(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.split("%")[0].toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

export function validateLoopbackHost(host: string): void {
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Server bind host must be a literal loopback address");
  }
}

export function deriveProxyRequestContext(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  remoteAddress: string | undefined,
  canonicalOrigin: string,
): { clientIp: string } {
  if (!isLoopbackAddress(remoteAddress)) {
    throw new ProxyBoundaryError("Requests must arrive through the loopback reverse proxy");
  }
  const canonical = new URL(canonicalOrigin);
  const forwardedProto = singleHeader(headers, "x-forwarded-proto");
  if (forwardedProto !== "https") {
    throw new ProxyBoundaryError("Reverse proxy must attest one HTTPS protocol value");
  }
  const host = singleHeader(headers, "host");
  if (!host || host.toLowerCase() !== canonical.host.toLowerCase()) {
    throw new ProxyBoundaryError("Request host does not match the canonical origin");
  }
  const forwardedHost = singleHeader(headers, "x-forwarded-host");
  if (forwardedHost && forwardedHost.toLowerCase() !== canonical.host.toLowerCase()) {
    throw new ProxyBoundaryError("Forwarded host does not match the canonical origin");
  }
  const forwardedFor = singleHeader(headers, "x-forwarded-for");
  if (forwardedFor === undefined) return { clientIp: "unknown" };
  const clientIp = forwardedFor.trim();
  if (!clientIp || clientIp.includes(",") || isIP(clientIp) === 0) {
    throw new ProxyBoundaryError("Reverse proxy supplied an invalid client address");
  }
  return { clientIp };
}

function rawTarget(request: IncomingMessage): { pathname: string; target: string } {
  const target = request.url;
  if (
    !target ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#") ||
    target.length > 8_192
  ) {
    throw new ProxyBoundaryError("Request target is invalid");
  }
  const queryIndex = target.indexOf("?");
  const pathname = queryIndex === -1 ? target : target.slice(0, queryIndex);
  if (!pathname) throw new ProxyBoundaryError("Request path is invalid");
  return { pathname, target };
}

function toFetchRequest(
  incoming: IncomingMessage,
  canonicalOrigin: string,
  target: string,
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const part of value) headers.append(name, part);
    } else {
      headers.set(name, value);
    }
  }
  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(new URL(target, canonicalOrigin), init);
}

async function writeFetchResponse(
  outgoing: ServerResponse,
  response: Response,
  requestMethod: string,
): Promise<void> {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  const getSetCookie = Reflect.get(response.headers, "getSetCookie") as unknown;
  const setCookies =
    typeof getSetCookie === "function"
      ? (getSetCookie.call(response.headers) as string[])
      : response.headers.get("Set-Cookie")
        ? [response.headers.get("Set-Cookie") as string]
        : [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") outgoing.setHeader(name, value);
  }
  if (setCookies.length > 0) outgoing.setHeader("Set-Cookie", setCookies);

  if (requestMethod === "HEAD" || response.status === 204 || response.status === 304 || !response.body) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    outgoing.end();
    return;
  }
  const stream = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream,
  );
  stream.once("error", (error) => outgoing.destroy(error));
  stream.pipe(outgoing);
}

function simpleJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function createPortfolioHttpServer(options: {
  application: PortfolioApplication;
  canonicalOrigin: string;
  onError?: (error: unknown) => void;
}): Server {
  const canonical = new URL(options.canonicalOrigin);
  if (canonical.protocol !== "https:" || canonical.origin !== options.canonicalOrigin) {
    throw new Error("Node adapter requires one canonical HTTPS origin");
  }

  const server = createServer(
    {
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 16 * 1_024,
      requestTimeout: 15_000,
    },
    async (incoming, outgoing) => {
      try {
        const { pathname, target } = rawTarget(incoming);
        if (pathname === "/healthz") {
          if (!isLoopbackAddress(incoming.socket.remoteAddress)) {
            await writeFetchResponse(
              outgoing,
              simpleJsonResponse(403, { error: "Forbidden" }),
              incoming.method ?? "GET",
            );
            return;
          }
          if (incoming.method !== "GET" && incoming.method !== "HEAD") {
            const response = simpleJsonResponse(405, { error: "Method not allowed" });
            response.headers.set("Allow", "GET, HEAD");
            await writeFetchResponse(outgoing, response, incoming.method ?? "GET");
            return;
          }
          await writeFetchResponse(
            outgoing,
            simpleJsonResponse(200, { status: "ok" }),
            incoming.method ?? "GET",
          );
          return;
        }

        const context = deriveProxyRequestContext(
          incoming.headers,
          incoming.socket.remoteAddress,
          options.canonicalOrigin,
        );
        const request = toFetchRequest(incoming, options.canonicalOrigin, target);
        const response = await options.application.handle(request, {
          ...context,
          rawPathname: pathname,
        });
        await writeFetchResponse(outgoing, response, request.method);
      } catch (error) {
        if (!(error instanceof ProxyBoundaryError)) options.onError?.(error);
        if (outgoing.headersSent) {
          outgoing.destroy();
          return;
        }
        await writeFetchResponse(
          outgoing,
          simpleJsonResponse(error instanceof ProxyBoundaryError ? 421 : 500, {
            error: error instanceof ProxyBoundaryError ? "Misdirected request" : "Internal server error",
          }),
          incoming.method ?? "GET",
        );
      }
    },
  );
  server.maxRequestsPerSocket = 100;
  return server;
}

export async function listenLoopback(
  server: Server,
  options: { host: string; port: number },
): Promise<void> {
  validateLoopbackHost(options.host);
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("Server port is invalid");
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
}

export async function closeGracefully(
  server: Server,
  options: { timeoutMs: number } = { timeoutMs: 10_000 },
): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, options.timeoutMs);
    timer.unref();
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
