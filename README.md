# Jin Kim portfolio: Mac mini protected originals

The public repository and GitHub Pages build remain a **public fallback**. The protected portfolio now runs on the owner's Mac mini: Caddy terminates public HTTPS and proxies to a Node.js 22 backend bound only to a literal loopback address. Protected originals are never copied into `dist/` or the server bundle.

> [!IMPORTANT]
> Self-hosting prevents new unauthenticated delivery through this application; it cannot retract files already obtained from prior public Git history, forks, clones, caches, or downloads. An authenticated viewer can also save or photograph media. This is access control, not DRM.

## Security boundary

```text
browser --HTTPS--> Caddy --HTTP/loopback--> Node 22
                                            |-- allowlisted dist/ public files
                                            `-- authenticated, hash-checked external originals
```

The backend owns these same-origin routes:

| Route | Behavior |
| --- | --- |
| `POST /api/auth/login` | Bounded JSON body, exact canonical `Origin`, bounded in-memory per-client limiter before password verification |
| `GET /api/auth/session` | Validates the signed, expiring session cookie |
| `POST /api/auth/logout` | Same-origin cookie expiry |
| `GET /api/projects` | Guest-safe locked placeholders or opaque protected URLs for a valid session |
| `GET`, `HEAD /protected/:routeId` | Authenticates first, then re-confines and SHA-256-verifies the external file before bytes/metadata are returned |
| `GET`, `HEAD /healthz` | Loopback liveness endpoint used by Caddy |
| other `GET`, `HEAD` paths | Exact allowlisted files from the validated `dist/` tree |

Sessions use a server-signed `__Host-portfolio_session` cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and a two-hour default lifetime. Private API/media responses use `Cache-Control: private, no-store`. Static and media responses receive CSP, HSTS, CORP, framing, referrer, permissions, and MIME-sniffing protections.

At startup the process fails closed unless:

- the bind host is exactly `127.0.0.1` or `::1`;
- the canonical origin is one exact HTTPS origin;
- all versioned verifier, pepper, and session secrets are well formed;
- `dist/` contains exactly the expected public files and no symlinks;
- the protected root is a real directory outside the checkout;
- every selected source is a regular, confined file whose SHA-256 matches `config/portfolio-manifest.json`.

The owner-confirmed protected scope remains Warhaven 12–20 and 22, Project MP 25–29, and all Project DM images (33 originals total). The production root is external to this checkout:

```text
/Users/minionion/portfolio-protected-media/KimYeonkyu-Resume/originals
```

## Build and focused verification

Requirements: Node.js 22+, npm, and Python 3.10+ for the existing browser tests.

```sh
npm ci
npm run typecheck
npm run test:server
npm run build
npm run check:dist
```

- `npm run build:public` recreates the allowlisted public `dist/` and keeps the committed guest-only manifest current.
- `npm run build:server` creates the dependency-bundled production entry point at `server-dist/server.mjs`.
- `npm run test:server` uses temporary public/private roots and generated in-memory secrets. It does not require production media, Keychain entries, Caddy, or network access.

The browser-focused tests remain available with `npm run test:browser` after installing `requirements-dev.txt` and Playwright Chromium.

## Production operation

There are deliberately no deploy, object-storage, or cloud CLI scripts. Production secrets are read at process startup from three named macOS Keychain generic-password entries; plaintext environment secrets are rejected when `NODE_ENV=production`. Caddy must overwrite the forwarded host/protocol/client headers exactly as shown in [`deploy/Caddyfile.example`](deploy/Caddyfile.example).

Use [`docs/mac-mini-deployment.md`](docs/mac-mini-deployment.md) for the owner-operated build, Keychain, Caddy, startup, verification, and rollback procedure. This repository does not install Caddy, edit Keychain, create a launchd service, change networking, or start production automatically.
