# Scrappy

Personal, free price tracker. The phase-one probe evaluates product extraction;
the scheduled runner validates and persists due reviews in Supabase and pings
Healthchecks.io. Alert states and push/email notifications are implemented;
session authentication, product/list/settings APIs and all phase-three web screens
are implemented. Local web/PWA development is accepted; deployment remains pending.

## Local setup (PowerShell)

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ./scraper
Copy-Item .env.example .env
# Fill SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env, then load them:
Get-Content .env | ForEach-Object {
    if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}
.\.venv\Scripts\python.exe -m scrappy.run --mode all
```

Python 3.11+ is required. The CLI selects overdue active products, uses saved domain
recipes, validates fresh readings and atomically records each review and its
attempts. Rejected readings preserve the last valid price and increment the failure
counter; accepted readings reset it. Completed runs record review counts; interrupted
runs retain partial counts without claiming completion. Connection errors exit
nonzero with no credentials in logs. Apply the alert recovery migration before
running this version: active and error products are reviewed, three consecutive
failures set status to error, and an accepted reading restores active status.
Supported modes are `all`, `product` (requires a UUID `--product-id`, bypasses the
interval for an active/error product), and `test_notification` (no price reviews).
The CLI reads process environment variables; `.env` is loaded
by the PowerShell snippet above. Use unquoted values. Keep all credentials out of
source control and client code.

## Session authentication API

Node.js 22.12+ is required. Run `npm ci` to install the locked dependencies.
Configure `ACCESS_KEY`, `SESSION_SECRET` (at least 32 UTF-8 bytes),
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the Vercel server. Use a random
session secret; these values must never use a `VITE_` prefix or enter a client
bundle. `.env.example` lists the names without credentials.

For local web and API development, put these four values in the root `.env`:
`ACCESS_KEY` (your login key), `SESSION_SECRET` (a random secret of at least 32
UTF-8 bytes), `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` (server key).
The existing Supabase project must have the login migration installed (migration
4 below); list operations also need migration 5. No Vercel account, CLI or login
is needed. Local product readings run the existing Python CLI from `.venv`
automatically; install the scraper dependencies using Local setup above.
`GITHUB_TOKEN` and `GITHUB_REPO` are needed only for deployed readings through Actions. Notification and migration
setup variables are not needed to start the web/API. Leave `VERCEL` unset.

| Endpoint | Behavior |
|---|---|
| `POST /api/login` | Same-origin JSON `{ "key": "..." }`; 200 on success, 401 for a wrong key, 429 with `Retry-After` when limited. |
| `GET /api/session` | 200 with `{ "authenticated": true }` for a valid session; otherwise 401. |
| `POST /api/logout` | Requires a valid session and same origin; clears the cookie. |

Login uses a constant-time digest comparison. Sessions last 30 days and use the
signed `__Host-scrappy_session` cookie with `Path=/`, `HttpOnly`, `Secure` and
`SameSite=Strict`; HTTPS is required. Rotating either access credential invalidates
existing sessions. Responses are never cached and never return the session token.
All future protected API routes must use the existing `withSession` guard.

Apply migration 4 below before using login. The RPC `record_login_attempt` admits
five attempts per IP in a rolling 15-minute window, including successful attempts.
A transaction-level advisory lock serializes the count and insert for equivalent
addresses across serverless instances ([PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)).
The sixth attempt is not inserted and returns the remaining wait in seconds;
even a correct key cannot bypass it. An attempt exactly 15 minutes old is outside
the window. Each new attempt removes records older than one day for that IP.
Only `service_role` can execute the invoker-security RPC; the table retains RLS
with no public policies. Missing trusted IPs and database failures return 503
without issuing a session. On Vercel, only `x-vercel-forwarded-for` is used; local
execution uses the socket address and ignores forwarded headers.

```powershell
npm run test:auth # Also compiles the affected TypeScript.
# Before installing migration 4: preview it with all fixtures rolled back.
npm run test:auth:sql
# After installing migration 4: test permissions and real concurrent RPCs.
npm run test:auth:sql -- --installed
```

SQL tests load `.env` directly and require the existing local
`SUPABASE_ACCESS_TOKEN`. Installed-mode concurrency tests also require
`SUPABASE_SERVICE_ROLE_KEY`: they create random documentation-only IP fixtures,
wait for all requests to finish and remove the rows in `finally`. The migration
remains installed; transactional fixtures are rolled back. Prefer a test project
for routine checks. No access key or session secret is needed for these SQL tests.

Verified on 2026-10-08: compilation and 13 authentication unit tests passed;
migration preview and installed SQL assertions passed, including denied calls as
`anon`/`authenticated`, permitted calls as `service_role`, invalid addresses,
expiration and pruning. Twelve concurrent service-role REST RPC requests using
equivalent IPv6 spellings admitted exactly five and blocked seven; a concurrent
request from a different IP succeeded, the exhausted IP also blocked a successful
attempt, and exactly five rows remained before fixture cleanup. All concurrent
fixture rows were confirmed removed. Vercel deployment remains pending.

## Lists API

All routes require the existing signed session. Mutations require the same origin;
POST, PATCH and PUT accept JSON only. Responses use `no-store` and Spanish errors.

| Endpoint | Request and response |
|---|---|
| `GET /api/lists` | 200 `{ "lists": [...] }`, sorted by position, creation time and ID. |
| `POST /api/lists` | `{ "name": "...", "emoji": "📱" }`; 201 `{ "list": {...} }`, appended to the order. Emoji is optional. |
| `PATCH /api/lists/:id` | `{ "name": "..." }`; 200 `{ "list": {...} }`. Optional emoji replaces the current value; `null` clears it. |
| `PUT /api/lists/reorder` | `{ "ids": ["uuid", "uuid"] }`; 200 `{ "lists": [...] }`. Include every list exactly once; an empty collection accepts `[]`. |
| `DELETE /api/lists/:id` | 200 `{ "deleted": true }`; 409 if products still reference the list. |

Names are trimmed and contain 1–100 Unicode code points; emoji accepts up to 16.
Unknown fields and malformed IDs return 400. Missing lists return 404; a stale
collection during reorder returns 409 so the client can reload. Storage failures
return a generic 503 without exposing database details or credentials.
Migration 5 provides the service-role-only invoker RPC `mutate_list`. A table lock
serializes mutations, including direct table writes, while allowing reads. Reorder
validates the complete ID set before updating; deletion compacts the remaining
positions without removing products or their history. No client Supabase access
or additional credentials are required.

```powershell
npm run test:lists
npm run test:lists:sql # Preview migration and fixtures transactionally.
npm run test:lists:sql -- --installed # Test the installed function; fixtures roll back.
```

Verified on 2026-10-08: 12 API tests and transactional PostgreSQL assertions passed,
including session/origin rejection, validation, service-role permissions, reorder
rollback, missing lists and nonempty deletion. Migration 5 and the lists screen
are complete; Vercel deployment remains pending.

## Web access

The React/Vite access screen uses locally bundled Inter, dark Tailwind tokens and
shadcn/ui button/input primitives. Tailwind follows its official
[Vite integration](https://tailwindcss.com/docs/installation/using-vite).
It restores the session before showing the form, confirms cookie acceptance after
login, and clears the entered key after each request. No credentials or session
tokens enter browser storage. Failed restoration offers a retry; failed logout
keeps the authenticated view so it can be retried. A 401 during logout returns to
access because the session is already invalid. Authentication requests time out
after 15 seconds and display fixed Spanish messages, including the rate-limit wait.

```powershell
npm run dev      # Web + API together at https://localhost:5173; loads root .env.
npm run test:dev # HTTPS integration: routing, login, cookies and malformed bodies.
npm run test:web # UI flow, transport errors and boundary cases.
npm run build    # Server/client type checks and production bundle.
```

Open `https://localhost:5173`, accept the local self-signed certificate warning,
then log in with your `ACCESS_KEY`. The development-only
[basic SSL plugin](https://github.com/vitejs/vite-plugin-basic-ssl) generates its
certificate under ignored `.scrappy/certs/`; no global certificate installation
is required. Use that exact HTTPS address throughout the session. The server binds
to localhost and fails if port 5173 is occupied. Stop the previous Vite process
first. Restart `npm run dev` after editing `.env`; API TypeScript edits reload
through [Vite's server module loader](https://vite.dev/guide/ssr.html).
For a phone on the same Wi-Fi, run `npm run dev -- --host 192.168.1.4`, replacing
the example address with the PC's Wi-Fi IPv4 address from `ipconfig`. Open
`https://<PC-Wi-Fi-IP>:5173` on the phone, accept the local certificate warning
and sign in with `ACCESS_KEY`. Keep the PC and development server running;
`localhost` on a phone refers to the phone itself. This command serves web and API
together and binds only to the selected network address.
The local middleware executes the original `api/` handlers, parses JSON bodies,
and returns JSON 404s for unknown API routes instead of the web's HTML fallback.
It preserves the production cookie flags, origin checks and database rate limit.
The adapter maps HTTP/2 `:authority` to `Host` before origin validation so browser
requests work over TLS as well as HTTP/1.1 requests.
Credentials remain in Node's process environment; never prefix them with `VITE_`.
On Vercel, Vite builds `dist/` and Functions serves unchanged `api/` handlers.
`npm run preview` only previews the production frontend; it does not run the API.

## PWA and local acceptance

Run `npm run dev:pwa` on Windows and open `https://localhost:5173`.
This builds and serves the real PWA plus the same local API with one command.
Stop the existing server first, and keep the PC running. Regular `npm run dev`
keeps hot reload; use `dev:pwa` for installation, offline and update acceptance.
Changes require rebuilding; `npm run build` while `dev:pwa` is running publishes
the next local version. Reopen the app to detect it, then choose **Actualizar**
after saving pending edits; **Más tarde** keeps the current version.

For development acceptance, use the local `localhost` origin and emulate a mobile
viewport in the browser on Windows. No phone setup, certificate authority, or
second device is needed. Check the screens and product, list, settings, and sign-in
flows locally. Real PWA installation on Android/iPhone, opening the installed app,
public HTTPS, and offline behavior on a physical device belong to the deployment
phase, after Vercel is configured. The service worker precaches only static app
files and bundled fonts/icons; API responses, sessions, product data, and store
images are not cached, and mutations are not queued offline. The browser checks
the server session each time the app launches.

Manual checks (no developer tooling required beyond PowerShell):

```powershell
# In another terminal while npm run dev is running:
curl.exe -k -i https://localhost:5173/api/session
# Expected before login: 401, application/json, Spanish login error (never HTML).
curl.exe -k -i https://localhost:5173/api/unknown
# Expected: 404, application/json.
```

In your browser, enter `ACCESS_KEY`, confirm Home appears, reload to
confirm the session persists, and log out to return to access. In the browser's
Network panel, `POST /api/login` and the subsequent `GET /api/session` must return
200 JSON with `authenticated: true`. A 503 on login means server configuration,
Supabase connectivity or the login migration needs checking; a 429 means wait for
`Retry-After` (five attempts per IP every 15 minutes, including successful logins).
Do not put the real access key in a shell command or commit it.
Home provides product cards, list selection, filters, sorting and product details.
Settings is available from Home. The default interval (3, 6, 12 or 24 hours)
is stored under `settings.default_interval_hours`; an absent key means six
hours. New product readings load this value before confirmation, and existing
products retain their individual intervals. Settings also shows the latest
recorded run and notification history in pages of 20 attempts.
The test button sends once to both ntfy and Gmail SMTP, using the existing
server-only notification variables in `.env.example`, and records each outcome
independently. Nodemailer provides SMTP delivery for the TypeScript API.
If a connection or audit fails, inspect the history and channel before repeating
the test; delivery may have succeeded even if its result was not recorded.
No additional migration or account is required for Settings.

Final phase-three local review passed on 2026-10-09. Access, Home, lists, adding
with confirmation, product details and Settings were accepted at 320/390 px,
including updates, logout, offline recovery and static-only caching. The closing
review corrected an abandoned product load that could hide the empty-list state
and restored PWA mocks in the two affected web suites. Local development is ready
for deployment; moving to main is the owner's decision. Public HTTPS, production
Actions/integrations and physical PWA installation still require deployment acceptance.

## Phase-three deployment decision (prepared 2026-10-09)

Preparation is complete on `develop`; nothing has been published by this task.
The owner decides when to release the reviewed phase-three changes to `main`.
Read-only `git ls-remote --heads origin main develop` currently returns only
`develop`: remote `main` does not exist. Repository settings, secret presence,
remaining Actions allowance and a Vercel project have not been verified here.
Local acceptance remains valid; production acceptance is still open (SPEC 12/14).

### Configuration ready in the repository

`vercel.json` selects Vite, installs the lockfile with `npm ci`, runs the existing
typechecked PWA build and publishes `dist`. The 10 TypeScript files in `api/`
remain native Node functions; Python and browser scraping stay in Actions.
Functions have a 60-second limit, including Settings SMTP; the app shell and
`sw.js` must revalidate so the existing update prompt can detect a new release.
There is no catch-all rewrite to HTML over API routes. The UI uses the root URL.
Only `main` can trigger automatic Git deployments; this does not prevent manual
deployments or select the project's Production Branch for you.
See [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json)
and [Git deployment rules](https://vercel.com/docs/project-configuration/git-configuration).

`check-prices.yml` now guards the job with `github.ref == 'refs/heads/main'`.
Until `main` becomes GitHub's default branch, scheduled jobs on `develop` will
skip. The API dispatches `reading` and `product` with `ref: main`; `reading`
requires `reading_id`, and `product` requires `product_id`. The workflow retains
one shared queue, no cancellation, and a 20-minute timeout. Reading mode does not
send alerts or ping the production heartbeat. GitHub schedules run on the default
branch and can be delayed; [workflow trigger documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

### Server values to configure when publishing

Use existing private values from `.env` where appropriate; never paste them into
chat, source files, screenshots or shell command arguments. Configure Vercel values
for **Production only**, with sensitive storage for credentials. Leave Preview
and Development without production credentials. Changes to Vercel variables need
a new deployment: [environment scopes](https://vercel.com/docs/environment-variables)
and [sensitive values](https://vercel.com/docs/environment-variables/sensitive-environment-variables).

| Value | Vercel Production | GitHub repository Secrets | Requirement |
|---|---|---|---|
| `ACCESS_KEY` | Yes | No | Private login key; rotation invalidates sessions. |
| `SESSION_SECRET` | Yes | No | Random, at least 32 UTF-8 bytes; rotation invalidates sessions. |
| `SUPABASE_URL` | Yes | Yes | Existing project's HTTPS URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Yes | Server key; never expose to the client. |
| `GITHUB_TOKEN` | Yes | No | Fine-grained PAT limited to `SRT0808/Scrappy`, repository Actions: write; track expiry. |
| `GITHUB_REPO` | Yes | No | `SRT0808/Scrappy`. |
| `NTFY_TOPIC` | Yes | Yes | Same private topic, at least 24 URL-safe characters. |
| `GMAIL_USER` | Yes | Yes | Gmail sender with two-step verification. |
| `GMAIL_APP_PASSWORD` | Yes | Yes | Google app password, not the account password. |
| `NOTIFY_EMAIL_TO` | Yes | Yes | Recipient address. |
| `HEALTHCHECK_URL` | No | Yes | Existing `https://hc-ping.com/<uuid>` ping URL. |

Settings sends its test directly from the Vercel API, so all four notification
values are required there as well as in Actions (an addition to SPEC 12's original
Vercel list). The Actions job uses its automatic `GITHUB_TOKEN` only for checkout;
do not copy the PAT into GitHub Secrets. Keep `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_URL` and `LOCAL_HTTPS_*` local. Do not define any `VITE_` secret.
Vercel supplies `VERCEL=1` automatically; enable automatic system environment
variables in the project. Authentication relies on that flag for HTTPS origin
checks and the trusted `x-vercel-forwarded-for` address.

### Ordered release steps — only after the owner's decision

1. Review the accumulated working-tree changes and commit the accepted work on
   `develop`, excluding `.env`, `.scrappy/` and local certificates. Push `develop`
   only after that review. Record the exact release commit; do not publish a
   partial phase-three tree. All six Supabase migrations are recorded as installed;
   confirm migration 6's `product_readings` table/RPCs remain present and RLS is
   enabled. Do not rerun migrations on the existing project.
2. In GitHub, confirm the seven repository Secrets in the table and the available
   Actions allowance. Keep **Check prices** disabled in Actions during setup.
   Subscribe to the topic in the ntfy phone app, confirm the Gmail app password,
   and retain the existing Healthchecks 3-hour period/9-hour grace configuration.
   Disabling a live workflow may trigger its missing-heartbeat alert.
3. The owner creates remote `main` from the exact reviewed `develop` commit
   (GitHub Branches → New branch, source `develop`, for this first release), then
   makes `main` the default branch in repository settings. For later releases,
   review a `develop` → `main` PR. The agent must not create, commit or merge on
   `main` as part of preparation. Return local development to `develop`.
4. Create a personal Vercel **Hobby** account/project only now, import
   `SRT0808/Scrappy` and select `main` for the initial deployment. Verify Production
   Branch tracking is `main` before publication: Vercel can otherwise select the
   default branch. Root directory is the repository root; preset is Vite; use
   the install/build/output values above. Select Node **24.x**, matching the
   current Windows runtime and the package's `>=22.12` requirement. Node 24.x
   and 22.x are supported: [Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).
   Add the ten Production values before deploying. Use the free `*.vercel.app`
   domain and its public HTTPS; no paid domain or local certificate is needed.
5. Confirm the build succeeds and all 10 API functions are present. Ensure
   the production URL is accessible for normal PWA use with Scrappy's own login.
   Check unauthenticated `/api/session` returns 401 JSON with `Cache-Control:
   no-store`; `/api/login` must execute a function, not serve app HTML. Log in
   through the browser and check session persistence/logout and cookie flags
   `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`. If login returns 503,
   inspect configuration, trusted IP handling and Supabase connectivity before
   attempting product mutations.
6. When ready for real reviews and alerts, enable **Check prices**. This also
   enables the three-hour cron against real stored products; it cannot be treated
   as a fixtures-only test. Manually dispatch `test_notification` on `main` once,
   confirm both deliveries and a successful heartbeat, and inspect its summary.
   Then use the deployed UI to read a known supported URL (Adafruit from the
   recorded probe is a candidate), confirm the workflow ran on `main` in `reading`
   mode, select/confirm the result once and use **Revisar ahora**. Verify `product`
   mode updated history and that a scheduled `all` run later succeeds.
7. On the owner's physical phone, open the stable production URL and install as
   a PWA using the browser's installation/Add to Home Screen flow. From the
   installed app verify access, list CRUD, add/confirm, details/charts/edit/pause,
   Settings/default interval, one notification test and **Revisar ahora**.
   Check offline notice and blocked mutations, reconnection and logout. For the
   update prompt, use a later approved deployment and verify defer/apply behavior
   on that same origin. Never publish an unreviewed change only to test updates.
   Record the release SHA, URL, phone/browser, Actions run IDs, receipt outcomes
   and pass/fail results in STATUS without private values. Close Fase 3 only when
   this physical PWA flow passes; Fase 4's deliberate heartbeat outage stays separate.

Hobby is for personal noncommercial use; inspect its included resources before
activation and stay on the free plan: [Hobby limits](https://vercel.com/docs/plans/hobby).
GitHub Free currently includes 2,000 private-repository minutes monthly; confirm
the account's remaining shared quota and keep paid overage disabled. At eight
scheduled jobs daily, estimate `240 × average billed minutes per job` for 30 days,
plus manual reading/review/probe runs; measure new runs instead of assuming probe
timings describe production. [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

If acceptance fails, keep Fase 3 open, disable **Check prices** to stop new reviews,
and let any running job finish (disabling is not cancellation). Resolve the defect
on `develop`; publishing that correction still requires the owner's decision.
For later releases, Vercel can restore a previous accepted deployment, but this
does not revert Supabase data, already sent notifications or the workflow in
`main`. The first release has no previous accepted deployment; use local
`npm run dev` while correcting it. Do not delete data or repeat sends blindly.

## Notifications

Configure `NTFY_TOPIC` as a random private topic of at least 24 URL-safe characters,
subscribe to it in the ntfy phone app, and set `GMAIL_USER`, `GMAIL_APP_PASSWORD`
(Google app password with two-step verification) and `NOTIFY_EMAIL_TO`.
The same four secrets are already wired into Actions. No new account is required
for ntfy. Publishing uses [ntfy JSON](https://docs.ntfy.sh/publish/) over HTTPS;
email uses [Gmail SMTP](https://support.google.com/a/answer/176600) over SSL on
port 465, with plain text and escaped HTML.

Both channels are attempted independently, with sent/failed rows in notifications;
credentials, the private topic and raw transport errors are excluded from history.
A goal triggers at or below the target and changes state only after at least one
confirmed send. Both delivery failures leave it eligible for the next review.
Triggered goals repeat only at an additional drop of at least 5% from the last
notified price; rearming requires a price strictly above 103% of the target.
Decimal arithmetic preserves exact inclusive/exclusive threshold comparisons.
Unavailable and rejected readings cannot send goal alerts. Suspicious changes are
reported after their review is persisted. Read-failure reminders are limited to
one pair of attempts every seven days within a failure streak, including failed
delivery attempts; a successful reading starts a new streak.

Actions serializes runs in the existing concurrency group. Avoid simultaneous
local and Actions runs. External delivery and database writes cannot be atomic:
a process crash or database failure after delivery can cause a repeated message.
Audit failures fail the run after still attempting both channels, and state writes
reject a changed review/alert version.

Phase 2 delivery acceptance passed on 2026-10-08: two local reviews of isolated
product `587d4cb6-2192-4252-acd6-064ad3c1d82a` with a controlled HTML fixture at
S/ 100 produced exactly one `goal_reached` sent record per channel. The second
review added no notifications; the product ended triggered and was paused.
The owner confirmed one phone push, one email, correct accents and a working link.
The recovery migration SQL integration and final manual code review passed;
configure the same four repository secrets before enabling production Actions.

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s scraper/tests -p test_alerts.py -v
.\.venv\Scripts\python.exe -m unittest discover -s scraper/tests -p test_notifications.py -v
# Sends real push and email; only run after configuring the four secrets:
.\.venv\Scripts\python.exe -m scrappy.run --mode test_notification
```

## Extractor probe

Run the fixed sample of 15 products from 12 domains (7 Peruvian URLs), after
installing the package with the setup above:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.scrappy/browsers'
.\.venv\Scripts\scrapling.exe install
.\.venv\Scripts\python.exe -m scrappy.probe scraper/urls.txt --output .scrappy/local.json --state .scrappy/local-recipes.json
```

The CLI tries browser-fingerprinted HTTP, Chromium, then stealth, with one attempt
per mode, a 25-second navigation/request timeout and random 2–8 second pauses.
Domains are interleaved. A remembered successful mode runs first on later probes.
Use `--timeout 30` to change the timeout or `--max-mode http` to limit escalation.
URLs must be HTTP(S) without embedded credentials. No account login is performed.
HTTP errors and challenge pages cannot count as successful reads.

Extraction tries JSON-LD, meta/microdata, an owner CSS recipe and visible-price
candidates. It rejects nonpositive prices, ambiguous currencies, conflicting
prices and low-confidence candidates. JSON-LD supports nested products, graphs,
arrays, offer references, price specifications and aggregate low prices.
Unavailable offers retain their availability, and the lowest available offer is
preferred. Out-of-stock products count as readable; alerts belong to phase two.
Heuristics exclude installments, shipping, tax, struck prices and related products.
Candidate selection and CSS teaching are available in Add product. Review-time validation confirms large
price changes with a fresh reading before persistence.

JSON and Markdown reports contain each URL's name, price, currency, strategy,
confidence and successful mode. Each attempt records HTTP status, final URL,
duration, body size and SHA-256; returned HTML is stored beside the report for
diagnosis. Exceptions retain their type without arbitrary response/cookie text.
Reports do not contain request headers or credentials. `.scrappy/` is ignored.
The CLI exits nonzero for invalid input or persistence failures; individual
unreadable shops are reported and do not abort the sample. A score below 70%
requires reviewing the evidence and proposing adjustments before phase two.

`--persist-recipes` additionally loads/saves `domain_recipes` through the server
Supabase REST API, using the existing two Supabase environment variables. It
updates only successful modes and preserves owner selectors. Without that flag,
recipes stay in the local JSON state file; no Supabase credentials are required.
The manual **Probe extractor** workflow uses the same sample, compares against
`scraper/results/local.json`, writes its summary and retains HTML evidence as the
`probe-results` artifact for seven days. It shares the scheduled job's concurrency
group and browser cache, and does not ping the production heartbeat.

Adaptive fingerprints use a JSON storage adapter for pinned Scrapling 0.4.15 and
the existing `domain_recipes.adaptive_state` column. CSS is always tried first;
relocation is a fallback at 80% structural similarity and requires confirmation,
even when it finds a valid price. Fingerprints are isolated per product URL;
changing the pinned version invalidates old fingerprints. This avoids relying on
an ephemeral runner's default SQLite file. The implementation follows Scrapling's
[storage interface](https://github.com/D4Vinci/Scrapling/blob/v0.4.15/scrapling/core/storage.py).

Affected tests (no additional dependencies):

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s scraper/tests -p test_extract.py -v
.\.venv\Scripts\python.exe -m unittest discover -s scraper/tests -p test_probe.py -v
.\.venv\Scripts\python.exe -m unittest discover -s scraper/tests -p test_recipes.py -v
# Optional integration, with the existing Supabase environment loaded:
$env:SCRAPPY_TEST_SUPABASE = '1'
.\.venv\Scripts\python.exe -m unittest discover -s scraper/tests -p test_recipes.py -k test_supabase_adaptive_round_trip_in_new_process -v
Remove-Item Env:SCRAPPY_TEST_SUPABASE
```

The integration test creates a uniquely named `.invalid` recipe, restores its JSON
in a fresh Python process with a changed CSS class and price, then removes the
test row. It never changes products or price history. Run against a test Supabase
project for routine development; phase-one verification uses an isolated row in
the configured project because no second project is configured.

### Phase-one results (2026-10-08)

The same 15 URLs were evaluated locally on Windows and on the Linux Actions
runner: [run 37857815799](https://github.com/SRT0808/Scrappy/actions/runs/37857815799).
Machine-readable reports are in `scraper/results/local.json` and
`scraper/results/actions.json`; Actions includes the per-URL comparison.
Local raw HTML is in `.scrappy/local-evidence/`; the downloaded remote evidence
is in `.scrappy/remote/actions-evidence/`. Actions also retains it in the
`probe-results` artifact for seven days. Successful rows were checked against
their saved source markup; confidence is an estimate, not a guarantee.

| Successful strategy / total sample | Local | Actions |
|---|---:|---:|
| JSON-LD | 9/15 (60.0%) | 8/15 (53.3%) |
| Meta / microdata | 3/15 (20.0%) | 3/15 (20.0%) |
| Owner recipe / heuristic / adaptive | 0/15 | 0/15 |
| Total readable | **12/15 (80.0%)** | **11/15 (73.3%)** |
| Unreadable | 3/15 | 4/15 |

| Product / shop | Local price | Actions price | Method; required mode |
|---|---|---|---|
| Lenovo IdeaPad Slim 3i / Falabella | Failed | Failed | No trusted price; all modes attempted |
| Logitech M90 / Ripley | 29 PEN | Failed | JSON-LD; HTTP locally; Actions 403 in all modes |
| Logitech G203 white / Hiraoka | 109.00 PEN | 109.00 PEN | JSON-LD; HTTP |
| Logitech MK120 / Sercoplus | Failed | Failed | Maintenance, HTTP 503 in all modes |
| Logitech MK120 V2 / Memory Kings | 48.50 PEN | 48.50 PEN | JSON-LD; HTTP |
| Logitech G502 K/DA / Impacto | Failed | Failed | Rendered prices need a recipe/payment choice |
| Raspberry Pi 4 4 GB / Adafruit | 120 USD | 120 USD | JSON-LD; HTTP |
| Raspberry Pi Pico / Pimoroni | 4.0 GBP | 6.0 USD | JSON-LD; HTTP; lowest available offer |
| Raspberry Pi Pico / The Pi Hut | 3.80 GBP | 3.80 GBP | Meta; HTTP |
| Logitech M185 / Walmart | 13.99 USD | 13.99 USD | Meta; HTTP |
| Logitech M185 / Best Buy | 27.28 USD | 27.28 USD | JSON-LD; HTTP locally, dynamic in Actions |
| Arduino Uno Rev3 / Arduino | 27.6 USD | 27.6 USD | JSON-LD; HTTP |
| Logitech M90 / Hiraoka | 29.9 PEN | 29.9 PEN | JSON-LD; HTTP; out of stock |
| micro:bit v2 Go Bundle / Adafruit | 19.95 USD | 19.95 USD | JSON-LD; HTTP |
| Raspberry Pi Pico W / The Pi Hut | 5.80 GBP | 5.80 GBP | Meta; HTTP |

All 12 local successes used HTTP; Actions required HTTP for 10 and dynamic for
Best Buy after an HTTPError. No URL succeeded only in stealth. Falabella's HTTP
HTML has an empty `offers` array; both browser modes timed out after 25 seconds.
Sercoplus's 503 body says the shop is being updated. Impacto's rendered HTML
contains PEN/USD cash and card prices and says out of stock; those values are not
recognized confidently by the present generic strategies. An owner CSS recipe
and explicit payment/currency choice are the next adjustment for that shop.
Do not substitute a related product's price or infer zero for unavailable items.

Ripley returns a Cloudflare challenge with 403 from Actions in all three modes,
while the local IP reads it over HTTP. Pimoroni redirects Actions to `/en-us/`
and returns USD; the same input URL returns GBP locally. These are observed
environment/IP differences; the experiment does not isolate IP from OS/browser
fingerprint or geographic storefront behavior. The subsequent engine must pin
the confirmed currency and flag changes before any alert (SPEC 8.5).
Memory Kings has meta amount 48.86 but both JSON-LD and the principal visible
price are 48.50 PEN, supporting the structured-data priority for this sample.

The overall sample clears the indicative 70% gate in both environments. Coverage
is weaker for the seven Peruvian URLs: 4/7 locally and 3/7 in Actions. These
figures describe this small sample and do not establish universal shop coverage.
For the failing stores, use a current priced product URL for Falabella, retry
Sercoplus after maintenance, teach a recipe for Impacto, and consider the free
local-runner fallback for Ripley if the cloud challenge persists. No paid proxy
or new service was introduced. Phase two can start with readable domains and
must continue reporting the unsupported stores.

Adaptive persistence is viable: local and Actions integration tests saved a
versioned JSON fingerprint to Supabase, restored it in a fresh process without
local state, relocated a changed class and read the changed price (99.90 to
119.90 PEN). The relocated result correctly requires confirmation. Read-back
confirmed eight successful domain recipes, including Best Buy `dynamic`; the
other seven are `http`. Both uniquely named integration rows were removed.
This validates the serialization and storage path; it does not establish reliable
automatic relocation across every real shop redesign. CSS remains the primary
owner recipe and adaptive matching stays a confirmation fallback.

Validation: 26 affected unit tests and the isolated Supabase integration passed
locally and in Actions. Closing review added one graph-order regression test,
which passed locally; re-extraction of 16 local and 15 remote saved HTML responses
confirmed unchanged report results after that correction. The remote run tested
commit `68d32a9`; the reviewed reference-order fix is commit `6bb657c`.
No blocking issue remained in the probe review; review-time validations,
notification state and teaching UI belong to the next phases.

The local probe took 191.80 seconds, the Actions probe 192.91 seconds, the complete
job 234 seconds and the workflow 238 seconds. Browser cache hit was confirmed by
the skipped browser installation; system dependency setup took 17 seconds.
One manual probe is not a production-cycle estimate: the sample intentionally
includes escalation failures. The timing API still returns zero billable
milliseconds, so actual account billing remains unconfirmed.

## Supabase setup

Create a Free project and apply these migrations once, in order, using the
Dashboard SQL editor:

1. `supabase/migrations/20261008000000_initial_schema.sql`
2. `supabase/migrations/20261008010000_review_persistence.sql`
3. `supabase/migrations/20261008020000_alert_recovery.sql`
4. `supabase/migrations/20261008030000_login_attempts.sql`
5. `supabase/migrations/20261008040000_lists.sql`

All five migrations were applied on 2026-10-08; do not rerun them. The third
extends review selection/persistence for error recovery without altering tables;
the fourth adds the atomic login rate-limit RPC; the fifth adds the lists mutation
RPC. Neither changes existing data during installation.
All eight tables have RLS enabled, no public policies, and no public table grants.
The review RPCs are executable only by `service_role`; concurrent stale writers
are rejected before history or product state can change. Only trusted server code
uses `SUPABASE_SERVICE_ROLE_KEY`.

Persistence checks use Python, without `psql` or additional dependencies. Load
`.env` with the setup snippet, then run:

```powershell
.\.venv\Scripts\python.exe -c "from scrappy.persistence import Database; Database().request('GET', 'runs?select=id&limit=1'); print('Connection OK')"
.\.venv\Scripts\python.exe -m unittest discover -s scraper/tests -p test_run.py -v
$env:SCRAPPY_TEST_SQL = '1'
# Before applying migration 3, preview it transactionally with:
# $env:SCRAPPY_TEST_ALERT_MIGRATION = '1'
try {
    .\.venv\Scripts\python.exe -m unittest discover -s scraper/tests -p test_persistence.py -v
} finally {
    Remove-Item Env:SCRAPPY_TEST_SQL
}
```

The SQL integration requires the local `SUPABASE_ACCESS_TOKEN` and calls the
Supabase Management API. It tests the installed functions, interval boundaries,
rejected and accepted reviews, stale writers, permissions and atomic rollback.
All generated fixture data is rolled back; no migration is applied permanently.
With `SCRAPPY_TEST_ALERT_MIGRATION=1`, migration 3 is included inside the same
transaction and rolled back as well; remove the flag after testing.
Verified on 2026-10-08: the Python client connection, 18 review unit tests and the
transactional SQL integration passed against the configured project. The SQL
integration also passed against the permanently installed recovery migration.
`SUPABASE_DB_URL` is optional for local database tools; neither setup credential
belongs in Actions or Vercel.

## Add a product with confirmation

The authenticated panel reads a public product URL through `/api/products/readings`
and the local Python CLI (GitHub Actions in production), then shows extraction confidence, up to five candidates and
an optional CSS selector. Confirm the price and currency, edit the reference,
choose a list, target and 3/6/12/24-hour interval (default 6), then save.
The queue stays separate from active products; an atomic, idempotent confirmation
creates the product, initial price history and learned domain recipe.

Apply `supabase/migrations/20261009000000_product_readings.sql` after validating
it with `npm run test:products:sql` (transactional rollback). Use
`npm run test:products` and `npm run test:web -- tests/web/AddProduct.test.tsx`
for the affected API and UI tests, and run the Python `test_readings.py` tests.
Migration 6 was installed on 2026-10-09; do not rerun it. `npm run dev` serves
web/API and launches `.venv` Python readings in the background using the server's
`.env`. No branch push or GitHub dispatch is needed locally. Each child is bounded
to three minutes and stopped when the development server closes. If the local
executor fails, retry with a new reading ID; existing readings remain queryable.
Configure `GITHUB_TOKEN` with Actions write permission and `GITHUB_REPO` in
Vercel when deploying; their names already appear in `.env.example`.
Dispatch targets `main`, so the workflow's `reading` mode must be available on
that branch before testing real readings through the deployed UI. The user
decides when changes move from `develop` to `main`. Preview readings neither
send notifications nor ping the scheduled review heartbeat. Local blocked-page
evidence is saved under the ignored `.scrappy/readings/` directory.

All fetch modes reject nonpublic initial destinations. Browser modes use a
temporary localhost proxy that validates each HTTP request/HTTPS tunnel and
connects to the checked numeric IP, covering redirects and browser subrequests
without a second DNS lookup. Loopback proxy bypass and direct WebRTC UDP are
disabled. HTTP mode retains Scrapling's safe-redirect checks. The proxy uses only
Python's standard library; no service, certificate or account is required.
Run `python -m unittest discover -s scraper/tests -p test_network.py -v` in the
existing virtual environment for mocked DNS and localhost transport fixtures.

## GitHub Actions scaffold

`check-prices.yml` provides a three-hour schedule and manual dispatch, a shared
concurrency group, a 20-minute timeout, pip/browser caches and the connected empty CLI run.
GitHub schedules use the default branch; the production job now skips any ref
other than `main`. Make `main` the default branch when publishing, as described above.
Set repository Secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
`HEALTHCHECK_URL` before dispatching this phase. The heartbeat is required and
uses the check's `https://hc-ping.com/<uuid>` URL after success, or `/fail` on
failure. Configure `NTFY_TOPIC`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` and `NOTIFY_EMAIL_TO`
before using notifications, and validate phone/email delivery with test mode.
In Healthchecks.io, select a Simple schedule with a 3-hour period and 9-hour grace
time, and enable a verified email integration: an alert arrives after about 12
hours without success. Local CLI runs do not ping the production heartbeat.

Each execution reports elapsed runner time in the Actions summary. This is not
account billing usage: verify the current free-minute allowance and actual
account consumption before activating production scheduling.
Phase 0 was accepted on 2026-10-08: [Actions run 37856046874](https://github.com/SRT0808/Scrappy/actions/runs/37856046874)
recorded a completed empty run in Supabase and successfully pinged the heartbeat.
The first job took 56 seconds (64 seconds for the entire execution), including
browser installation. At eight runs daily, that observed job duration projects
to about 224 runner minutes over 30 days, before billing rounding and cache effects.
The timing API returned zero billable milliseconds at verification time; that
does not establish actual billed consumption. Check account usage after it updates.
As checked on 2026-10-08, GitHub Free includes 2,000 minutes per month for private
repositories, shared across the owner's account ([GitHub billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
Healthchecks.io Hobbyist monitors 20 jobs for free ([pricing](https://healthchecks.io/pricing/)).
Supabase Free includes two active projects and a 500 MB database, and may pause
projects with low activity over seven days; the scheduled database writes provide
regular activity ([pricing](https://supabase.com/pricing), [pausing](https://supabase.com/docs/guides/platform/free-project-pausing)).
GitHub schedules run on the default branch and can be delayed; public repositories
have schedules disabled after 60 days without repository activity
([schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)).
