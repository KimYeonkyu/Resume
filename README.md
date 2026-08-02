# Jin Kim portfolio: Cloudflare-protected media

> [!CAUTION]
> ## SECURITY BLOCKER — THIS IS NOT SECURE TO DEPLOY YET
>
> `KimYeonkyu/Resume` is public, and the provisional Project MP and Project DM media already exist in its current tree and Git history. The Worker cannot revoke copies, forks, caches, or old public URLs. **Do not describe this portfolio as protected and do not connect a production hostname until the owner has remediated the public source/current tree/history as appropriate, unpublished or replaced the old static site, and verified every old protected-media URL no longer serves media.** The R2 bucket must remain private.
>
> This coding pass intentionally does not remove media or rewrite history. Those operations require owner approval and coordination. See the mandatory gate in [the Cloudflare deployment runbook](docs/cloudflare-deployment.md#security-gate-mandatory-before-any-live-upload-or-deployment).

This branch adds a Korean entrance screen with two modes:

- **면접용 전체 포트폴리오** opens a server-verified password form. One valid login unlocks all protected projects for the browser session.
- **공개 포트폴리오** first clears any existing server session, then shows protected projects as very dark, non-interactive locked cards and never requests their media.

Project MP and Project DM are **provisionally** protected because the resume labels them `미공개`. The single owner-reviewable source of truth is [`config/portfolio-manifest.json`](config/portfolio-manifest.json). Review it before every deployment; protection scope is a policy decision, not something inferred by the Worker.

## Architecture and security boundary

One Cloudflare Worker handles authentication, session-filtered manifests, private R2 reads, and the static-assets fallback:

| Route | Behavior |
| --- | --- |
| `POST /api/auth/login` | Same-origin, bounded JSON login; 16–256 UTF-8 password bytes; per-IP/location rate limit before PBKDF2-HMAC-SHA-256 and constant-time digest verification |
| `GET /api/auth/session` | Validates the signed, expiring session cookie |
| `POST /api/auth/logout` | Expires the session cookie |
| `GET /api/projects` | Returns protected URLs only for a valid session; guests receive locked display metadata |
| `GET /protected/*`, `HEAD /protected/*` | Resolves an allowlisted route ID, validates the cookie, then reads private R2 |
| all other paths | Served from the allowlisted `dist/` assets through `ASSETS` |

The session cookie is HMAC-signed and uses `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and a two-hour default lifetime. Protected responses use `Cache-Control: private, no-store`. `assets.run_worker_first` ensures requests pass through the Worker before static asset lookup; this follows Cloudflare's [static-assets binding model](https://developers.cloudflare.com/workers/static-assets/binding/). Cookie choices align with the [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

`LOGIN_RATE_LIMITER` allows 10 accepted-shape login attempts per 60 seconds for each `CF-Connecting-IP` in each Cloudflare location, before the expensive password derivation. Its configured `namespace_id` is `2026080201`; the owner must confirm that integer is unique across their Cloudflare account because bindings that reuse an ID share counters. Cloudflare documents that [Workers rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) are local, permissive, and eventually consistent, so a zone-level [WAF rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) is also recommended as defense in depth.

The deterministic build copies only explicitly allowed public assets. It compiles Tailwind locally from `styles/resume.css` into the self-hosted `dist/resume.css`; the resume does not execute a third-party script. It excludes the provisional protected directories/PDFs, rejects matching protected bytes, and scans public HTML/JS/JSON/CSS for protected source paths, object keys, route IDs, filenames, and runtime secret values. Static assets and successful protected-media responses receive `Cross-Origin-Resource-Policy: same-origin`; static responses also receive a restrictive Content Security Policy with self-only scripts, styles, connections, fonts, and media (plus `data:` images), with framing, plugins, and base-URL changes disabled.

This design prevents unauthenticated delivery through this Worker. It **cannot** prevent an authenticated viewer from downloading, saving, photographing, or screenshotting artwork.

## Local setup and verification

Use Node.js 22+, Python 3.10+, and Chromium for Playwright:

```sh
npm ci
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements-dev.txt
python3 -m playwright install chromium
```

Run the full local gate from the repository root:

```sh
npm run typecheck
npm run test:worker
npm run build
npm run check:dist
npm run test:runtime
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider
npm run check:dist
git diff --check
```

The explicit build and distribution check must precede runtime and browser pytest. `npm run test:runtime` also rebuilds internally, but it does not replace that pre-test security gate.

`npm run r2:upload` is a non-mutating plan. `npm run deploy` is live and must not be run until every security gate and account step in the runbook is complete.

## Secrets

Never put the portfolio password, its hash, the session signing secret, or Cloudflare credentials in source, command arguments, `.dev.vars`, generated assets, logs, chat, or documentation. Choose a unique, high-entropy interview password whose UTF-8 encoding is 16–256 bytes; both the no-echo helper and server enforce those byte bounds. The deployment runbook pipes the password-hash helper and ephemeral session-secret helper directly to Wrangler. Cloudflare recommends encrypted [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) instead of plaintext configuration; the password work factor follows the [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

## Deployment status

No Cloudflare upload, Worker deployment, DNS change, or R2 mutation is part of this repository change. **Live deployment remains blocked on this machine because there is no authenticated Wrangler session or confirmed Cloudflare account configuration**, in addition to the public-source security blocker above.

For owner-run provisioning, upload, deployment, verification, and safe rollback instructions, use [`docs/cloudflare-deployment.md`](docs/cloudflare-deployment.md).
