# Mac mini production runbook

This runbook is owner-operated. It documents the reviewed runtime but does **not** install software, edit Keychain, create launchd jobs, change firewall/router/DNS settings, or start production as part of this repository change.

## 1. Runtime layout

- Caddy owns the public hostname and TLS certificates.
- Node listens on `127.0.0.1:8794` only and refuses wildcard/LAN binds.
- Public files come from the checked `dist/` allowlist.
- Protected originals remain outside the checkout at:

  ```text
  /Users/minionion/portfolio-protected-media/KimYeonkyu-Resume/originals
  ```

- Production credentials come from macOS Keychain at startup. They are never bundled, copied to `dist/`, or accepted from plaintext environment variables in production.

Keep the repository/public build and external media root separately backed up. Previous public Git history and already downloaded copies are outside this server's control.

## 2. Build a reviewed release

From a clean reviewed checkout with Node.js 22:

```sh
npm ci
npm run typecheck
npm run test:server
npm run build
npm run check:dist
```

Expected artifacts:

- `dist/`: exact public allowlist, including the guest-only static manifest;
- `server-dist/server.mjs`: bundled Node production entry point.

Do not copy the external originals into either output. Review `git status --short` and `git diff --check`. The runtime performs its own full external-root confinement and hash validation before it starts listening.

## 3. Publish and verify the guest-safe Pages build

The main-branch CI must deploy the exact `dist/` artifact that passed `npm run check:dist`; do not publish the repository root or reconstruct the artifact in a separate deployment step.

Before opening the protected hostname to interview traffic:

1. Confirm the latest GitHub Pages build reports `built` for the intended main commit.
2. Load the public page and confirm it fetches only `public-portfolio-manifest.json`, with no `/api/` or `/protected/` requests.
3. Probe `GET` and `HEAD` for every historical protected source path, its percent-encoded variants, and every protected PDF. Each must return `404` or `410`, never media bytes.
4. Confirm the interview choice links to the canonical protected HTTPS origin.

If the verified artifact cannot be deployed, disable GitHub Pages and confirm the old URLs no longer serve media. Do not expose the protected origin before this gate passes. A temporary public-site outage is safer than leaving an unauthenticated bypass online.

## 4. Create the three Keychain values privately

Use a unique password-manager-generated interview password with at least 8 characters and no more than 256 UTF-8 bytes; 32 or more characters is strongly recommended. Do not reuse a personal or corporate password.

The local helpers write no files and do not echo password input:

```sh
python3 scripts/generate-password-secrets.py
python3 scripts/generate-session-secret.py
```

Their output is secret. Run them only in a private local terminal, do not use `tee`, redirection, shell history, chat, tickets, screenshots, or committed files, and clear the terminal scrollback after transferring the values.

Using **Keychain Access** (not shell command arguments), create/update three **generic password** items. Give every item the same account value chosen for `PORTFOLIO_KEYCHAIN_ACCOUNT` (for example, `portfolio-runtime`) and these exact service names:

| Service | Value envelope |
| --- | --- |
| `com.jinkim.portfolio.password-verifier` | `hmac-sha256-v1$…` |
| `com.jinkim.portfolio.password-pepper` | `pepper-v1$…` |
| `com.jinkim.portfolio.session-secret` | `session-v1$…` |

The Node process account must be allowed to read those items. A Keychain permission prompt is an owner action; automation must not click it. Rotating the session entry invalidates all previously issued cookies. Rotate the verifier and pepper together when changing the interview password.

## 5. Configure non-secret runtime settings

Set these in the owner-controlled process environment (or a future owner-reviewed launchd plist):

```sh
export NODE_ENV=production
export PORTFOLIO_CANONICAL_ORIGIN=https://portfolio.example.com
export PORTFOLIO_PROTECTED_MEDIA_ROOT=/Users/minionion/portfolio-protected-media/KimYeonkyu-Resume/originals
export PORTFOLIO_PUBLIC_ROOT=/absolute/path/to/reviewed/checkout/dist
export PORTFOLIO_KEYCHAIN_ACCOUNT=portfolio-runtime
export PORTFOLIO_BIND_HOST=127.0.0.1
export PORTFOLIO_PORT=8794
```

Optional bounded defaults are:

- `PORTFOLIO_SESSION_TTL_SECONDS=7200` (allowed: 60–28800);
- `PORTFOLIO_LOGIN_LIMIT=10`;
- `PORTFOLIO_LOGIN_WINDOW_MS=60000`;
- `PORTFOLIO_LOGIN_MAX_KEYS=4096`.

Do not set `PORTFOLIO_SECRET_SOURCE=environment` in production; the loader rejects it. Do not put verifier, pepper, session secret, or password values in a plist, `.env`, shell command, or log.

## 6. Configure Caddy

Copy [`deploy/Caddyfile.example`](../deploy/Caddyfile.example) into the owner's Caddy configuration and replace only the placeholder hostname. The hostname must exactly match `PORTFOLIO_CANONICAL_ORIGIN`.

Keep `admin off` in production. Reload by validating the complete file and restarting the owner-controlled Caddy service; do not expose the unauthenticated default localhost administrator API.

The reverse proxy must overwrite, rather than trust client-supplied, values for:

- `Host` and `X-Forwarded-Host`;
- `X-Forwarded-Proto: https`;
- `X-Forwarded-For: {remote_host}`.

Validate the owner configuration before reload:

```sh
caddy validate --config /path/to/Caddyfile
```

Do not expose port 8794 on a LAN/wildcard interface. A direct loopback request may use `GET /healthz`; every non-health application request requires the canonical HTTPS proxy attestation.

## 7. Start and verify the protected origin

After Caddy is validated and the non-secret environment is present:

```sh
npm start
```

Startup is ready only after it prints the loopback listening message. Any missing file, symlink, external-root escape, manifest mismatch, hash mismatch, malformed secret, invalid origin, or unsafe bind fails before `listen()`.

Local liveness:

```sh
curl --fail --silent http://127.0.0.1:8794/healthz
```

From the canonical HTTPS hostname, verify:

1. `/` and `/jin_kim_portfolio.html` return `200` with HSTS, CSP, CORP, `nosniff`, frame denial, and the expected public bytes.
2. `/api/auth/session` returns an unauthenticated state before login.
3. `/api/projects?mode=public` contains locked placeholders and no `sourcePath`, `sha256`, `routeId`, or `/protected/` locator for selected items.
4. Direct unauthenticated `GET` and `HEAD /protected/<opaque-id>` return `401` and no media.
5. Wrong-origin, wrong-host, or non-HTTPS-forwarded login requests fail and issue no cookie.
6. A correct browser login issues `__Host-portfolio_session` with `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and no `Domain`.
7. Authenticated `GET` returns the expected bytes with `private, no-store`; authenticated `HEAD` returns the same length/type with no body.
8. Logout expires the cookie and subsequent browser requests are guest-only.
9. Encoded separators, dot traversal, NULs, extra route segments, legacy protected paths, and unknown API paths never fall through to public static files.
10. The GitHub Pages fallback still loads only `public-portfolio-manifest.json` and never attempts a protected request.

Do not paste a real cookie, password, verifier, pepper, session secret, or protected media bytes into verification logs.

## 8. Graceful restart and rollback

Send `SIGTERM` for a normal stop. The backend stops accepting new connections, closes idle keep-alives, gives active responses up to ten seconds, then closes remaining connections. A second termination request forces connection closure.

For rollback, keep the previous reviewed `dist/` and `server-dist/server.mjs` together. Stop the current backend gracefully, point `PORTFOLIO_PUBLIC_ROOT` and the working directory at the previous matched release, and restart. Do not roll back to a build that contains protected originals or lacks the external-root/hash checks. The external originals and Keychain items are not modified by application rollback.

If integrity or credential exposure is suspected, stop serving the protected application, investigate the external root, rotate both password entries and the session entry privately, rebuild/reverify, and only then restore service. Availability loss is safer than serving unverified protected bytes.
