import { createHmac, randomBytes } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";

export const CANONICAL_ORIGIN = "https://portfolio.example";

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function makeSyntheticSecrets(password = base64Url(randomBytes(36))) {
  const pepper = randomBytes(32);
  const verifier = createHmac("sha256", pepper).update(password, "utf8").digest();
  return {
    password,
    secrets: {
      passwordPepper: `pepper-v1$${base64Url(pepper)}`,
      passwordVerifier: `hmac-sha256-v1$${base64Url(verifier)}`,
      sessionSecret: `session-v1$${base64Url(randomBytes(32))}`,
    },
  };
}

export interface TestHttpResponse {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}

export async function requestServer(
  server: Server,
  options: {
    body?: string | Buffer;
    headers?: Record<string, string>;
    method?: string;
    path?: string;
    proxyHeaders?: boolean;
  } = {},
): Promise<TestHttpResponse> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server is not listening");
  const body = options.body;
  const headers: Record<string, string> = {
    Host: "portfolio.example",
    ...(options.proxyHeaders === false
      ? {}
      : {
          "X-Forwarded-For": "192.0.2.10",
          "X-Forwarded-Proto": "https",
        }),
    ...options.headers,
  };
  if (body !== undefined && headers["Content-Length"] === undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }

  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path: options.path ?? "/",
        method: options.method ?? "GET",
        headers,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () => {
          resolve({
            body: Buffer.concat(chunks),
            headers: incoming.headers,
            status: incoming.statusCode ?? 0,
          });
        });
      },
    );
    outgoing.once("error", reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

export function cookiePair(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error("Expected a Set-Cookie header");
  return value.split(";", 1)[0];
}
