# Cloudflare deployment and rollback runbook

This is the owner-operated production runbook for `jin-kim-protected-portfolio`. Run commands from the repository root on the reviewed commit. Commands marked **LIVE** mutate Cloudflare; nothing in this coding pass ran them.

> [!CAUTION]
> ## SECURITY GATE: mandatory before any live upload or deployment
>
> The repository `KimYeonkyu/Resume` is currently **PUBLIC**, and the provisional Project MP and Project DM files are already present in its current tree and Git history. A private R2 bucket and authenticated Worker do not make already-published copies private.
>
> **STOP. Do not run an R2 upload, set production secrets, deploy, change DNS, or claim protection until the owner has completed and recorded every item below.**

- [ ] Make this source repository private **before upload**, or migrate the protected-media workflow to an owner-controlled private source while keeping the public repository sanitized. The current build/check/upload scripts expect each `sourcePath` under the checkout, so the migration alternative requires a separate reviewed workflow change; do not improvise by copying untracked protected files into a public checkout.
- [ ] Ensure no public current branch/tree contains protected media. If this repository is made private, its local media can remain available to the uploader. If it stays public, remove the tracked media and complete the reviewed private-source migration first. Do not merely hide files in the UI or add them to `.gitignore`.
- [ ] Decide, approve, back up, and coordinate any required history cleanup with every collaborator. This branch deliberately does not rewrite history. GitHub warns that history rewriting affects clones, forks, pull requests, signatures, and cached references; follow GitHub's owner-led [sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository), not an improvised force-push.
- [ ] Unpublish the old GitHub Pages/static deployment or replace it with the protected Worker. GitHub documents how to [unpublish a Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/unpublishing-a-github-pages-site).
- [ ] Inventory **all** legacy hosts and URLs, including the default Pages hostname, custom domains, mirrors, CDNs, alternate case/encoding variants, and direct file URLs. Verify each protected URL returns no media after remediation.
- [ ] Account for forks, clones, third-party caches, archives, and copies. They may be impossible to retract; obtain the artwork owner's explicit acceptance of that residual exposure.
- [ ] Use a new Worker identity whose version history contains only this protected architecture. The configured name is `jin-kim-protected-portfolio`. If that name already has any legacy public-static version, stop and choose a fresh reviewed name before deployment.
- [ ] Create/use a private R2 bucket with **no Public Development URL and no custom domain**. Never point DNS directly at R2.
- [ ] Confirm that rate-limit namespace `2026080201` is unique across every Worker binding in the owner's Cloudflare account. Reusing it shares counters, even across Workers; do not deploy until any collision is resolved in a reviewed configuration change.

Only the owner can declare this gate complete. Passing the build checker is necessary but cannot repair prior publication.

## What will be deployed

[`wrangler.jsonc`](../wrangler.jsonc) defines one Worker with:

- `src/worker.ts` as the request entry point;
- the allowlisted `dist/` directory as the `ASSETS` binding with `run_worker_first: true`;
- the private `jin-kim-portfolio-private` R2 bucket as `PROTECTED_MEDIA`;
- `LOGIN_RATE_LIMITER`, namespace `2026080201`, allowing 10 checks per 60 seconds for a key within each Cloudflare location;
- a non-secret `SESSION_TTL_SECONDS` of `7200` (two hours).

Cloudflare documents that `run_worker_first` invokes the Worker before a matching asset and that R2 is accessed from a Worker through a binding: [static-assets bindings](https://developers.cloudflare.com/workers/static-assets/binding/) and [R2 Workers API bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). Its [Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) defines the account-unique namespace and per-location counter behavior used here.

The Worker owns these same-origin routes:

- `POST /api/auth/login`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `GET /api/projects`
- `GET` and `HEAD /protected/*`

Everything else is delegated to `ASSETS`. Guest manifests include only safe titles, counts, and locked placeholders for protected projects. They do not include protected filenames, source paths, R2 keys, route IDs, or URLs. Choosing explicit public mode first posts to logout, so an existing or concurrently restoring session is expired before the guest manifest is shown. Protected R2 reads happen only after a valid signed cookie and allowlisted route-ID lookup.

The resume's Tailwind input is compiled at build time from `styles/resume.css` to the self-hosted `dist/resume.css`; `index.html` loads `/resume.css` and no third-party executable script. The Worker adds `Cross-Origin-Resource-Policy: same-origin` to static assets and successful protected-media responses. Static responses also receive a restrictive CSP: scripts, styles, connections, fonts, and media are self-only; images additionally allow `data:`; base URL changes, object/plugin content, and framing are denied.

## 1. Prerequisites

- Owner approval and written completion of the security gate above.
- Node.js 22 or newer and npm.
- Python 3.10 or newer (required by the pinned pytest and Playwright releases).
- A Cloudflare account with Workers, the Rate Limiting binding, and R2 enabled; the intended account selected; and authority to create the Worker, bucket, secrets, and production route/domain.
- Control of the production hostname and the existing static-site configuration.
- An interactive terminal. The password helper uses no-echo terminal input.
- A clean, reviewed commit. Do not deploy an unreviewed or dirty tree.

Install the pinned development dependencies and browser once:

```sh
npm ci
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements-dev.txt
python3 -m playwright install chromium
```

Authenticate interactively, then confirm the intended account. These are read-only except for the browser login itself:

```sh
npx wrangler login
npx wrangler whoami
```

Stop if the account is wrong or the command is unauthenticated. Do not paste an API token into a shell command, file, issue, log, or chat. Cloudflare documents Wrangler authentication and R2 setup in its [R2 CLI guide](https://developers.cloudflare.com/r2/get-started/cli/).

Before any upload or deployment, inventory the owner's Worker configurations/private infrastructure registry and confirm `namespace_id` `2026080201` is unused by every other rate-limit binding in this account. Cloudflare currently does not expose binding counters/namespaces in the dashboard; a date-like number is not proof of uniqueness. Bindings that share an ID share counters for the same key, including across Workers. If a collision exists, stop: choose an unused positive integer, update `wrangler.jsonc` and its tests/types in a separate reviewed change, then rerun the complete gate. Do not “test” uniqueness by deploying it.

At runtime, a well-formed same-origin login whose password is within the accepted byte range calls `LOGIN_RATE_LIMITER` with `CF-Connecting-IP` before PBKDF2. Ten attempts per 60 seconds are allowed for that IP key in each Cloudflare location; excess attempts get the same generic failure with status `429`, and a binding error fails closed with `503`. The binding is intentionally local, permissive, asynchronously updated, and eventually consistent—not a global exact counter. Shared NAT/proxy IPs can also group legitimate viewers. Cloudflare explains these limitations in the [Rate Limiting binding documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/); configure a zone WAF rule later as defense in depth rather than treating the binding as the only brute-force control.

**Current status:** this machine has no confirmed Wrangler login/account configuration, so live deployment remains blocked.

## 2. Review the provisional protection manifest

[`config/portfolio-manifest.json`](../config/portfolio-manifest.json) is the obvious, single protection-policy manifest. Project MP and Project DM are provisional because the resume labels both `미공개`; the owner must confirm or change this scope before deployment.

Review all of the following together:

- every project-level `protected` value;
- every protected item's `sourcePath`, opaque `routeId`, `r2Key`, and `contentType`;
- `deploymentExclusions.directories` and `deploymentExclusions.files`;
- public item paths and the local DoMiniOnion video/poster;
- uniqueness of protected route IDs and R2 keys.

Use the diff and non-mutating upload plan:

```sh
git diff -- config/portfolio-manifest.json
npm run r2:upload
```

The current reviewed scope produces `Plan: 24 protected objects ...` followed by `No uploads performed`. A different count is not automatically wrong, but it requires owner review and corresponding tests before proceeding. The plan validates that sources are in-repository regular files and that R2 keys are constrained; it performs no network mutation.

Do not rename, move, delete, compress, or otherwise rewrite source media as part of this deployment review.

## 3. Run the complete local quality and security gate

```sh
npm run typecheck
npm run test:worker
npm run build
npm run check:dist
npm run test:runtime
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider
npm run check:dist
git diff --check
git status --short
```

Every command must exit `0`. The explicit `build` and `check:dist` must run before the workerd runtime tests and browser pytest because those tests consume `dist/`. `npm run test:runtime` now performs its own build too; keep the earlier build/check as the pre-test security boundary, and keep the final check after all tests. Review `git status --short`; only intentional source, test, configuration, and documentation changes may remain. Never deploy `node_modules/`, `.dev.vars*`, `.env*`, `.wrangler/`, test output, logs, or a manually assembled asset directory.

`npm run build` recreates `dist/` deterministically from an allowlist. `npm run check:dist` must report that protected media is excluded. It checks:

- excluded protected directories and PDFs are absent;
- no output file has bytes identical to a protected source;
- public HTML/JS/JSON/CSS contains no protected path, key, route ID, unique filename, or configured runtime secret value;
- all required public gallery/video assets are present;
- no output entry is a symbolic link.

The build also runs the pinned local Tailwind CLI over `styles/resume.css`, emits `dist/resume.css`, and leaves `index.html` pointing only to `/resume.css`. The runtime suite verifies the resume and portfolio contain no third-party executable `<script>` and that the Worker supplies the restrictive CSP/CORP headers.

Inspect the final asset inventory as an additional human check:

```sh
find dist -type f -print | LC_ALL=C sort
```

Confirm `dist/resume.css` is present. If any protected source or unexpected file appears, or if the resume refers to a remote executable script/style dependency, stop. Do not attempt to compensate with an R2 or Worker rule.

## 4. Create and prove the R2 bucket is private

The configured bucket name is `jin-kim-portfolio-private`. Cloudflare states that new R2 buckets are private by default, but public access can later be enabled through either `r2.dev` or a custom domain; both must remain absent. See [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Create the bucket only if `bucket info` confirms it does not already exist:

```sh
npx wrangler r2 bucket info jin-kim-portfolio-private
```

If it does not exist, this is **LIVE**:

```sh
npx wrangler r2 bucket create jin-kim-portfolio-private
```

Check both public-access mechanisms:

```sh
npx wrangler r2 bucket info jin-kim-portfolio-private
npx wrangler r2 bucket dev-url get jin-kim-portfolio-private
npx wrangler r2 bucket domain list jin-kim-portfolio-private
```

Required result: the Public Development URL is disabled and the custom-domain list is empty. If the development URL is enabled, disable it with this **LIVE** command and confirm again:

```sh
npx wrangler r2 bucket dev-url disable jin-kim-portfolio-private
npx wrangler r2 bucket dev-url get jin-kim-portfolio-private
```

If any custom domain is listed, first verify the exact target, then remove it interactively. These are **LIVE** commands:

```sh
read -r R2_PUBLIC_DOMAIN
npx wrangler r2 bucket domain remove jin-kim-portfolio-private --domain "$R2_PUBLIC_DOMAIN"
npx wrangler r2 bucket domain list jin-kim-portfolio-private
```

Do not configure R2 CORS, a presigned public link, `r2.dev`, or an R2 custom domain for this application. Browser media requests must go only to the same-origin Worker's `/protected/*` routes.

## 5. Plan and upload protected media

Run the safe plan again immediately before upload:

```sh
npm run r2:upload
```

Before execution, use the Cloudflare dashboard's R2 Objects view to confirm the target is the intended new/empty bucket. The uploader uses `put`; rerunning it replaces objects at the configured keys. Stop rather than overwrite an unexpected existing object set.

After the security gate is complete and the plan is approved, upload with this **LIVE** command:

```sh
npm run r2:upload -- --execute
```

The script uploads only protected manifest entries to the remote configured bucket, applies each declared content type, and stores `Cache-Control: private, no-store` metadata. It does not delete local media or remote objects.

In the R2 dashboard, verify the current manifest's expected object count and key prefixes, then repeat the private-access checks:

```sh
npx wrangler r2 bucket dev-url get jin-kim-portfolio-private
npx wrangler r2 bucket domain list jin-kim-portfolio-private
```

Do not share dashboard object links, S3 credentials, object keys, or screenshots of the protected object inventory.

## 6. Dry-run the Worker build

This command compiles and validates without uploading:

```sh
npm run build
npm run check:dist
npx wrangler deploy --dry-run
```

Review the output for exactly these bindings:

- `ASSETS` -> `./dist`, Worker first;
- `PROTECTED_MEDIA` -> `jin-kim-portfolio-private`;
- `LOGIN_RATE_LIMITER` -> account-confirmed-unique namespace `2026080201`, limit `10`, period `60` seconds;
- `SESSION_TTL_SECONDS` -> `7200`;
- no plaintext `PORTFOLIO_PASSWORD_HASH` or `SESSION_SECRET` variable.

Stop on any unexpected route, asset directory, binding, namespace, limit, period, or account. Dry-run output cannot prove account-wide namespace uniqueness; that owner check must already be complete.

## 7. Bootstrap a new fail-closed Worker and pipe secrets

This sequence assumes `jin-kim-protected-portfolio` is a **new Worker with no legacy public-static versions**. Check before bootstrapping:

```sh
npx wrangler deployments list
npx wrangler versions list
```

If the name already contains any old static version, do not reuse it and do not rely on rollback ordering. Choose a fresh Worker name in a reviewed configuration change and repeat all local gates.

Before attaching a production domain, create a protected baseline. Missing runtime secrets make authentication fail closed, and the checked `dist/` contains no protected media. This command is **LIVE**:

```sh
npx wrangler deploy --tag protected-baseline --message "Fail-closed protected portfolio baseline"
```

Record the returned Worker URL and version ID in the owner's private deployment record. Do not put that record or secrets in this public repository.

Choose a unique, high-entropy interview password and keep it out of source, shell arguments/history, files, logs, chat, and screenshots. Its UTF-8 encoding must be between 16 and 256 bytes; this is a byte limit, so character count can differ for non-ASCII text. Both the helper and Worker enforce the same range. Do not reuse a personal, corporate, or previously exposed password.

Generate and pipe both values directly to Cloudflare. The password is read twice without echo; neither helper writes a file. The owner enters the real password locally and never reveals it to the agent. These are **LIVE** commands:

```sh
set -o pipefail
python3 scripts/generate-password-hash.py | npx wrangler secret put PORTFOLIO_PASSWORD_HASH
python3 scripts/generate-session-secret.py | npx wrangler secret put SESSION_SECRET
```

Do not redirect either helper, use `tee`, copy its output to the clipboard, or put it in shell history/environment variables. Do not use `--secrets-file`; this workflow intentionally creates no credential file. Cloudflare explains that `wrangler secret put` stores encrypted Worker secrets and immediately creates/deploys a new version, so do this only on the new, non-production Worker: [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

After both secrets are set, rebuild, recheck, and deploy the reviewed final version. This is **LIVE**:

```sh
npm run build
npm run check:dist
npx wrangler deploy --tag protected-ready --message "Reviewed protected portfolio release"
npx wrangler deployments list
npx wrangler versions list
```

Record the `protected-baseline` version ID and the final `protected-ready` version ID. The baseline is the emergency fail-closed target; the ready version is the normal rollback target. Never use an unrecorded version merely because it is recent.

## 8. Verify the Worker before production cutover

Use the new Worker's returned HTTPS origin. Enter it at the prompt without a trailing path:

```sh
read -r PORTFOLIO_ORIGIN
PORTFOLIO_ORIGIN=${PORTFOLIO_ORIGIN%/}
curl --silent --show-error "$PORTFOLIO_ORIGIN/api/auth/session"
```

Expected JSON is an unauthenticated session. Verify static response hardening and the self-hosted resume stylesheet:

```sh
curl --silent --show-error --head "$PORTFOLIO_ORIGIN/"
curl --fail --silent --show-error --output /dev/null "$PORTFOLIO_ORIGIN/resume.css"
```

The resume response must include `Content-Security-Policy` and `Cross-Origin-Resource-Policy: same-origin`. The CSP must restrict executable scripts, styles, connections, fonts, and media to `'self'`, allow only the documented `data:` image exception, and deny objects, framing, and base changes. View source must reference `/resume.css` and contain no third-party executable `<script>` URL. The stylesheet request must return `200` from the same origin.

Verify an unauthenticated direct media route does not return an object. Obtain an opaque route ID from the private deployment review; do not publish it:

```sh
read -r PROTECTED_ROUTE_ID
curl --silent --show-error --dump-header - --output /dev/null "$PORTFOLIO_ORIGIN/protected/$PROTECTED_ROUTE_ID"
```

Expected: `401`, `Cache-Control: private, no-store`, and no R2 media body. A successful authenticated protected response must additionally send `Cross-Origin-Resource-Policy: same-origin`. Invalid/traversal-like paths must return `400` or `404`, never media.

Check the guest manifest structurally and compare it with every protected locator in the local policy manifest, without saving the response:

```sh
curl --fail --silent --show-error "$PORTFOLIO_ORIGIN/api/projects?mode=public" | node -e '
const { readFileSync } = require("node:fs");
const { posix } = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const body = JSON.parse(input);
  const config = JSON.parse(readFileSync("config/portfolio-manifest.json", "utf8"));
  const configuredProtected = config.projects.filter(project => project.protected);
  const protectedItems = configuredProtected.flatMap(project => project.items);
  const publicBasenames = new Set(config.projects.filter(project => !project.protected)
    .flatMap(project => project.items)
    .flatMap(item => [item.sourcePath, item.posterPath].filter(Boolean))
    .map(path => posix.basename(path).toLowerCase()));
  const encodePath = path => path.split("/").map(encodeURIComponent).join("/");
  const forbidden = protectedItems.flatMap(item => [
    item.sourcePath, encodePath(item.sourcePath), item.r2Key, item.routeId,
    ...(!publicBasenames.has(posix.basename(item.sourcePath).toLowerCase())
      ? [posix.basename(item.sourcePath), encodeURIComponent(posix.basename(item.sourcePath))]
      : []),
  ]);
  const protectedProjects = body.projects.filter(project => project.protected);
  const serialized = JSON.stringify(protectedProjects);
  const haystacks = [serialized];
  for (let pass = 0; pass < 2; pass += 1) {
    try { haystacks.push(decodeURIComponent(haystacks.at(-1))); }
    catch { break; }
  }
  const normalized = haystacks.map(value => value.normalize("NFC").toLowerCase());
  const leakedLocator = forbidden.some(value => normalized.some(text =>
    text.includes(value.normalize("NFC").toLowerCase())));
  const unsafeField = /"(?:url|sourcePath|r2Key|routeId)"\s*:/u.test(serialized);
  const safe = body.authenticated === false &&
    protectedProjects.length === configuredProtected.length &&
    protectedProjects.every(project => project.locked === true &&
      project.items.length === project.itemCount &&
      project.items.every(item => item.locked === true && item.type === "locked")) &&
    !unsafeField && !leakedLocator;
  if (!safe) process.exitCode = 1;
  else console.log("Guest manifest is locked and contains no protected locators.");
});'
```

Then use a fresh private/incognito browser and DevTools Network/Application panels. Do not record the password:

1. Confirm the entrance shows **면접용 전체 포트폴리오** and **공개 포트폴리오**.
2. Choose public mode. Confirm it first sends same-origin `POST /api/auth/logout`, then Project MP and Project DM render as dark locked cards, cannot open, and create zero `/protected/` requests or protected DOM URLs.
3. Confirm public categories, the resume, self-hosted `/resume.css`, and the local DoMiniOnion video/poster load; test desktop and a narrow mobile viewport with no horizontal overflow. Confirm no third-party executable script request occurs.
4. Exercise the full-screen viewer with keyboard left/right arrows, swipe, Escape/close, focus trapping, focus restoration, readable labels, and the local video controls.
5. Choose interview mode. Confirm a wrong entry returns only a generic error and issues no session cookie.
6. Submit the correct password with Enter. Confirm both Project MP and Project DM unlock from one login.
7. Open one item from each protected project. Confirm requests are same-origin `/protected/*`, return `200`, and include `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
8. Inspect the login response cookie: `__Host-portfolio_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and a bounded expiry of about two hours. These attributes follow [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
9. Refresh. Confirm the valid session restores both protected projects without another login.
10. While authenticated, use DevTools to set the session-storage preference to explicit public mode and reload: `sessionStorage.setItem('portfolio-access-mode', 'public'); location.reload();`. Confirm the client posts to logout, expires the valid cookie, and shows only the guest-safe manifest. This proves explicit public choice wins over session restoration.
11. Log in again, then select manual relock. Confirm the cookie expires, protected elements/URLs leave the DOM, the gallery becomes guest-safe, and the same direct protected route returns `401`.
12. Confirm an expired or modified cookie does not authenticate. Never paste the real cookie into a ticket, log, chat, or committed file.

Finally, recheck R2 itself:

```sh
npx wrangler r2 bucket dev-url get jin-kim-portfolio-private
npx wrangler r2 bucket domain list jin-kim-portfolio-private
```

Both public-access mechanisms must still be absent.

## 9. Prove old public URLs are gone

Do this for the complete owner-maintained inventory, not just one sample. For each legacy protected URL:

```sh
read -r OLD_PROTECTED_URL
curl --location --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$OLD_PROTECTED_URL"
```

Required result: no URL returns protected media. A redirect is acceptable only if its final response also does not expose media. Check the old custom domain, default Pages domain, raw repository URLs, case/percent-encoding variants, mirrors, and known CDN/cache URLs. Repeat from a logged-out browser and an unrelated network where practical.

Do not proceed because a single URL is fixed. The security gate remains open until the entire inventory is checked and residual fork/cache/archive exposure is explicitly accepted by the owner.

## 10. Production cutover

Only after sections 1–9 pass:

1. Add a zone WAF rate-limiting rule for the intended production hostname as defense in depth. In **Security -> WAF -> Rate limiting rules**, match the exact hostname and URI path `/api/auth/login`; also match `POST` where the account plan supports the Method field. Count by IP (or IP with NAT support where available), choose a threshold/period and block or managed-challenge duration appropriate for legitimate interview traffic and the account plan, save the rationale, and deploy the rule before advertising the hostname. Cloudflare provides the current [zone rule workflow](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/) and [login protection guidance](https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/). This WAF rule supplements, rather than replaces, the Worker's local 10-per-60-second binding.
2. In Cloudflare **Workers & Pages -> `jin-kim-protected-portfolio` -> Settings -> Domains & Routes**, attach the intended production custom domain/route to this new Worker.
3. Remove the old static origin from that hostname and unpublish the legacy Pages site. Do not leave an alternate Pages hostname serving the media.
4. Confirm DNS resolves to Cloudflare and repeat every check in sections 8 and 9 against the production HTTPS origin. Verify the WAF rule matches controlled excess traffic only in an approved test window; do not put a password or request body in logs.
5. Record the production hostname, reviewed Git commit, `protected-ready` version ID, `protected-baseline` version ID, manifest approval, test results, R2 privacy checks, account-unique rate-limit namespace, WAF rule configuration, and cutover time in the owner's private deployment record.

Never connect the production hostname directly to the R2 bucket. The Worker is the only media authorization boundary.

## 11. Safe rollback

Cloudflare rollbacks immediately create an active deployment and do not roll back bound resources such as R2; read the official [Workers rollback behavior](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) before acting.

> [!WARNING]
> **Never run `wrangler rollback` without an explicit version ID. Never select the old public-static version, never point DNS back to the old static site, and never re-enable GitHub Pages as a shortcut.** A working but public media site is not a safe rollback.

Select only a version ID recorded after it passed this runbook and was built with protected media excluded. Inspect it before the mutation:

```sh
npx wrangler deployments list
npx wrangler versions list
read -r SAFE_PROTECTED_VERSION_ID
npx wrangler versions view "$SAFE_PROTECTED_VERSION_ID"
```

Confirm the target is either the recorded `protected-ready` release or the fail-closed `protected-baseline`; it must use the Worker entry point, `ASSETS`, private `PROTECTED_MEDIA`, account-approved `LOGIN_RATE_LIMITER`, and the audited static response headers. Then roll back with this **LIVE** command:

```sh
npx wrangler rollback "$SAFE_PROTECTED_VERSION_ID" --message "Rollback to reviewed protected version"
```

Immediately repeat sections 8 and 9. R2 must stay private and intact; do not delete the bucket or objects during rollback.

If there is no verified protected version, **take the production route/site offline in Cloudflare instead of choosing a legacy public-static version**. In **Workers & Pages -> the protected Worker -> Settings -> Domains & Routes**, remove/disable the production route or custom domain, and ensure its DNS is not pointed at the legacy static origin. Confirm the hostname no longer serves media. Restore service only by deploying a freshly reviewed protected build through this runbook. Availability loss is safer than republishing protected artwork.

If session integrity may be affected, roll back first, then invalidate every session by piping a newly generated signing secret directly to the safe Worker:

```sh
set -o pipefail
python3 scripts/generate-session-secret.py | npx wrangler secret put SESSION_SECRET
```

If the interview password may be known, choose a new password privately and pipe a new hash with the no-echo helper. Do not log either value. Re-run all authentication and relock checks afterward.

## Limitations and owner responsibilities

- An authenticated viewer can save files, inspect responses, photograph the screen, or take screenshots. This system is access control, not DRM.
- Password sharing grants the same portfolio-wide access until sessions expire or `SESSION_SECRET` is rotated.
- A two-hour cookie bounds Worker-issued session lifetime; already downloaded copies cannot be revoked.
- The Worker rate limiter is per `CF-Connecting-IP` and Cloudflare location, permissive, and eventually consistent. It is not global exact accounting, and shared IPs can affect multiple legitimate viewers; keep the zone WAF defense and monitor `429`/`503` outcomes without logging submitted credentials.
- The application is same-origin only. Do not add a separate media domain, public R2 URL, cross-origin login, or client-side password fallback.
- The CSP/CORP policy assumes all executable code, styles, fonts, connections, and media remain same-origin. Review policy and tests before introducing any external runtime dependency; ordinary outbound resume links do not require third-party script execution.
- Private source and R2 stop new unauthenticated delivery; they cannot retract copies already obtained from the formerly public repository/site.
- Review `config/portfolio-manifest.json` before every release as publication policy changes.

## No live action in this coding pass

No Cloudflare login, rate-limit namespace registration, WAF change, R2 create/upload, secret update, Worker deployment, DNS change, Pages unpublish, repository visibility change, media removal, or history rewrite was performed here. Live deployment is expected to remain blocked until the owner supplies the Cloudflare account context and authenticates Wrangler, confirms namespace `2026080201` is account-unique, and fully remediates the conspicuous public-source security gate.
