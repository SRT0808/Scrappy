# Scrappy

Personal, free price tracker with a Spanish interface, individual products and
shopping baskets. Confirm extracted prices, track history and receive ntfy push
and Gmail alerts when your goals are met.

[Open Scrappy](https://scrappy-silk.vercel.app/) ·
[Specification](docs/SPEC.md) · [Project status and history](docs/STATUS.md)

- Products can stand alone or belong to several baskets with quantities/budgets.
- Basket totals use decimal arithmetic and dated USD/PEN rates from BCRPData.
  Incomplete readings/conversions block aggregate alerts; estimates stay marked.
- Price extraction tries structured data, metadata, owner CSS and heuristics,
  escalating from HTTP to browser modes. Shop blocks and currency differences
  can require confirmation, a recipe or the residential-IP fallback.
- React/Vite/TypeScript, Tailwind/shadcn/ui and Recharts provide the dark PWA.
  Vercel Functions alone access Supabase; Python/Scrapling 0.4.15 runs in Actions.
- Normal operation: cron-job.org → Actions every 3h, watched by Healthchecks
  (3h period + 9h grace), independently of Windows and Codex.

The existing deployment and acceptance evidence are complete as recorded below.
Final package review is complete (15 Oct 2026); commits and promotion remain
separate owner decisions.

## Reproducible setup and operation (SPEC 14, phase 4)

This is the current installation/operation path. The evidence index below records completed acceptance, not extra setup steps. The existing
installation is already deployed and accepted: do not rerun migrations, channel
tests, PWA acceptance, accelerated slots or heartbeat outages to use this guide.
For a new installation, follow steps 1–6; for the existing service, use step 7
and the Windows fallback only when needed. Main promotions remain the owner's
decision. These instructions introduce no paid service.

1. **Prepare the checkout on Windows 11.** Install Git, Node 24 and Python 3.12
   (the package supports Python 3.11+). Clone your repository, then work on
   `develop`; the owner selects the reviewed release for `main`. In PowerShell
   at the repository root:

   ```powershell
   git clone https://github.com/SRT0808/Scrappy.git
   Set-Location Scrappy
   git switch develop
   npm ci
   py -3.12 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -e ./scraper
   New-Item -ItemType Directory -Force .scrappy | Out-Null
   $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.scrappy/browsers'
   .\.venv\Scripts\scrapling.exe install
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ```

   Substitute your fork's URL if applicable. Keep `.env`, browser files and
   evidence private and ignored; never overwrite an existing `.env` during setup.

2. **Create the database once.** In a new Supabase Free project, open SQL Editor
   and execute the following repository files individually, in this order.
   Stop on any error; record each successful filename in your private installation
   ledger before continuing. An existing project uses its ledger, not a replay.

   ```text
   supabase/migrations/20261008000000_initial_schema.sql
   supabase/migrations/20261008010000_review_persistence.sql
   supabase/migrations/20261008020000_alert_recovery.sql
   supabase/migrations/20261008030000_login_attempts.sql
   supabase/migrations/20261008040000_lists.sql
   supabase/migrations/20261009000000_product_readings.sql
   supabase/migrations/20261011000000_list_baskets.sql
   supabase/migrations/20261011010000_basket_items.sql
   supabase/migrations/20261011020000_basket_snapshots.sql
   supabase/migrations/20261011030000_basket_alerts_repair.sql
   supabase/migrations/20261011040000_basket_experience.sql
   ```

   Copy the project HTTPS URL and legacy `service_role` key from the project's
   API settings to `.env`. RLS remains enabled with no public policies/grants;
   only server code uses the key. Never add a `VITE_` secret. On an existing
   database, back up data and exclude all writers before any new migration;
   migration `20261011010000` removes `products.list_id` and renames basket fields.

3. **Configure access and notification accounts.** Edit `.env` with unquoted
   `NAME=value` entries, without surrounding spaces. Set a private `ACCESS_KEY`
   and a random `SESSION_SECRET` of at least 32 UTF-8 bytes. Generate secrets
   with a password manager and save them privately, not in commands or chat.
   Set `NTFY_TOPIC` to a random private name of at least 24 characters from
   letters, digits, `_` and `-`. In the ntfy phone app, add a subscription on
   `https://ntfy.sh` with that exact topic; allow notifications and background
   delivery. The topic acts as a shared secret; do not use a predictable name.
   In your Google account Security settings, enable two-step verification,
   open App passwords and create one for Scrappy. Store it as
   `GMAIL_APP_PASSWORD` without grouping spaces; use the full sender address
   for `GMAIL_USER` and the recipient for `NOTIFY_EMAIL_TO`. If App passwords
   is unavailable under your account policy, that account cannot configure this
   SMTP path; use an eligible Gmail account rather than its login password.
   Both channels are attempted independently; each result is recorded.

   For local web/API, the four required values are `ACCESS_KEY`,
   `SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
   Add the four notification values for Settings and the fallback runner.
   Leave `VERCEL` unset locally. Run `npm run dev`, open
   `https://localhost:5173`, accept its local certificate warning and sign in.
   Stop with Ctrl+C. Local readings use `.venv`, without GitHub credentials.

4. **Publish only the owner's reviewed release.** The owner promotes it to
   `main` and makes `main` the GitHub default branch. In Vercel Hobby, import
   the repository with root directory `.`, Vite preset, Node 24.x, Production
   Branch `main`, install `npm ci`, build `npm run build`, output `dist`.
   Keep `vercel.json`; enable automatic system environment variables for
   `VERCEL=1`. Configure the ten Production-only values in the
   [server values table](#server-values-to-configure-when-publishing), replacing
   `SRT0808/Scrappy` with your repository for `GITHUB_REPO`. Create the API's
   fine-grained GitHub PAT for that repository with Actions read/write and
   record its expiry. Deploy after setting the values; changing them requires
   another deployment. Use the free HTTPS `*.vercel.app` origin, with Scrappy
   login accessible for ordinary use. Preview gets no production credentials.

5. **Configure the cloud runner and watchdog.** In GitHub Settings → Secrets
   and variables → Actions, add the seven secrets from that same table: both
   Supabase values, four notification values and `HEALTHCHECK_URL`. Do not copy
   the API PAT into Actions; checkout uses GitHub's built-in token. Create a
   Healthchecks check with Simple schedule, period 3 hours and grace 9 hours,
   add/verify its email integration and enable failure/recovery delivery. Save
   its `https://hc-ping.com/<uuid>` URL as `HEALTHCHECK_URL`. About 12 hours
   without a success can produce an absence alert. Leave the check active;
   outages/maintenance may therefore notify you. A local CLI run never pings it.

6. **Use exactly one scheduler: cron-job.org → Actions.** Keep **Check prices**
   enabled for dispatch on `main`; its workflow has no native `schedule`.
   In cron-job.org create a job initially disabled. Use POST, timeout 30 seconds,
   no redirect-as-success, save responses, timezone UTC, every day at minute 0
   of hours `0,3,6,9,12,15,18,21`, with no expiry. Enable provider email alerts
   for first failure, recovery and automatic disabling. Request URL:
   `https://api.github.com/repos/OWNER/REPO/actions/workflows/check-prices.yml/dispatches`.
   Add headers `Accept: application/vnd.github+json`,
   `Content-Type: application/json`, `X-GitHub-Api-Version: 2026-03-10`,
   `Authorization: Bearer <dedicated scheduler PAT>` and body
   `{"ref":"main","inputs":{"mode":"all"}}`. The dedicated fine-grained
   PAT has Actions read/write only for your repository; retain it privately and
   record expiry/rotation. No CRONJOB API key is needed for console operation.
   Enable the job only when the database/secrets/release are ready for real
   writes and alerts. Do not enable a second scheduler or Windows fallback.
   Existing installation: job `8633587` is already enabled; do not recreate it.

7. **Operate and diagnose.** The cadence is UTC every 3h (Lima 01:00, 04:00,
   07:00, 10:00, 13:00, 16:00, 19:00, 22:00). `all` selects due active/error
   products using their own intervals, refreshes FX and processes baskets;
   a successful run with zero due products is valid. The panel adds/repairs
   products with confirmed price/currency, pauses products, edits goals and
   displays history; **Revisar ahora** bypasses an individual interval.
   Check provider history, the corresponding Actions run on `main`/release SHA,
   runner summary, Supabase `runs` completion/counts and notification records,
   then Healthchecks' last success. A provider HTTP acceptance alone does not
   prove execution or persistence. Inspect expired PATs, disabled jobs, failed
   Actions steps, missing secrets and shop-block evidence in that order as
   applicable. Do not resend notifications or force reviews to fix bookkeeping.
   Preserve partial runs/data; fix code on `develop` and let the owner promote.
   Retain private evidence separately before workspace cleanup. Monitor account
   usage/cache/database size in provider dashboards, stay on free plans and do
   not enable paid overage. The measured mission limits below are historical,
   not a promise of future punctuality or allowance.

### Windows plan B: residential-IP runner

Use the same CLI/database when an Actions IP cannot read a shop. This is a
manual operational fallback, not an acceptance replay or a second live writer.
It performs real reviews, FX/snapshots, alert-state changes and applicable
ntfy/email sends. It does not solve every block and is not offline scraping.

Before switching, disable the cron-job.org job and **Check prices** workflow,
wait for running Actions jobs to finish and cancel any queued jobs. Also wait
for **Probe extractor** jobs sharing the cloud queue. Stop local runners and
`npm run dev`; refrain from deployed UI mutations/readings/**Revisar ahora**
and Settings notification tests throughout the fallback. Disabling a workflow
does not cancel existing jobs. Never rely on Actions concurrency or stale-write
rejection to serialize a Windows runner with cloud/API work. Keep Healthchecks
active: its cloud-heartbeat absence alert remains expected during fallback and
must not be suppressed by synthetic/local pings.

After completing setup steps 1–3, create the following private file
`.scrappy/run-local.ps1` using a text editor. No secret belongs in this file or
in Task Scheduler arguments; it loads the existing root `.env` at each run.

```powershell
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
Get-Content -LiteralPath (Join-Path $repoRoot '.env') -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}
Remove-Item Env:GITHUB_EVENT_NAME -ErrorAction SilentlyContinue
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $repoRoot '.scrappy/browsers'
& (Join-Path $repoRoot '.venv/Scripts/python.exe') -m scrappy.run --mode all
exit $LASTEXITCODE
```

Run manually from the repository root after excluding all other writers:

```powershell
powershell.exe -NoProfile -File .\.scrappy\run-local.ps1
# Inspect exit status, completed Supabase runs (trigger=local), counts and deliveries.
$LASTEXITCODE
```

For unattended Windows operation, open Task Scheduler → Create Task, name it
`Scrappy local fallback`, select your Windows user and **Run only when user is
logged on**, without highest privileges. Create a daily trigger repeating every
3 hours for 1 day, enabled. Action: program
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`; arguments
`-NoProfile -File "C:\Users\seba_\Proyectos_Personales\Scrappy\.scrappy\run-local.ps1"`;
Start in `C:\Users\seba_\Proyectos_Personales\Scrappy`. Replace both paths for
your checkout. Settings: **If the task is already running: Do not start a new
instance**; disable automatic retries and missed-start catch-up. Do not set an
arbitrary forced-stop time that can interrupt persistence. On a laptop, choose
whether to allow battery runs in Conditions; it must match your availability
expectation. Keep the same Windows user logged on with network access. If local
script execution is blocked by policy, resolve it under your Windows policy;
do not disable machine-wide protections or store an account password in commands.

Task history/Last Run Result `0` indicates CLI completion, not success of every
shop or delivery; inspect `runs`, product state and `notifications`. Nonzero
results or a missing `finished_at` need investigation before retrying. Windows
off, asleep, logged out or disconnected means no guaranteed review, catch-up,
notification or watchdog for the local task. Healthchecks still watches the
stopped cloud runner, not local health. A missed task does not replay historical
slots; the next `all` run selects currently due products.

To return to cloud operation, disable/delete `Scrappy local fallback`, wait for
its Python process/manual runs to finish, then enable **Check prices** and the
original cron-job.org job at its 3h UTC schedule. Resume UI use only after the
handover. Observe the next ordinary Actions completion and heartbeat recovery;
do not repeat the accepted six-slot mission, deliberate outage or channel tests.
No deletion/rollback of prior data or sent notifications is part of switching.

Documentation verification (2026-10-14 Lima): the ordered path was checked
against all 11 migration filenames, `.env.example`, `vercel.json`, the dispatch
workflow and CLI/notification code. The PowerShell wrapper was parsed locally;
no secrets were loaded, fallback task installed or real run/acceptance repeated.

## Server values to configure when publishing

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

## Development and release reference

`npm run dev` serves web/API together and loads root `.env`; restart it after
changing values. It binds localhost:5173 and fails if occupied. `npm run preview`
serves only the frontend. Local readings launch `.venv` Python without GitHub.
Development uses Windows/localhost with mobile emulation; physical PWA and public
HTTPS acceptance belong to deployment and are already recorded for this install.

```powershell
npm run build
npm run test:dev
npm run test:web
.\.venv\Scripts\python.exe -m unittest discover -s scraper/tests -p test_extract.py -v
# Isolated PostgreSQL 18 fixtures; no .env or production writes:
node tests/basket-items-sql.mjs
node tests/basket-snapshots-sql.mjs
node tests/basket-alerts-sql.mjs
node tests/basket-experience-sql.mjs
```

Run only checks affected by your change. `POSTGRES_BIN` overrides the PostgreSQL
binary directory; each SQL runner removes its isolated database. The legacy
`test:baskets:sql` fixtures target an intermediate schema, not today's contract.
The two opt-in Supabase integrations remain omitted under the owner's SPEC §15
waiver; these local commands do not claim they passed.

`npm run dev:pwa` builds and serves the PWA locally. Stop any previous server;
rebuild to test updates, then reopen and choose **Actualizar** or **Más tarde**.
Only static assets are precached: API/session/product data are not cached and
mutations are not queued offline. Each launch checks the server session.

Access uses `ACCESS_KEY`, an HttpOnly/Secure session cookie and same-origin checks;
no credentials enter browser storage. Login is limited to five attempts per IP
per 15 minutes (including successful attempts); respect `Retry-After` on 429.
A 503 suggests configuration, Supabase connectivity or migration trouble.
Anonymous `/api/session` returns 401 JSON; unknown `/api/*` returns 404 JSON.

Add/repair reads a public product URL, shows candidates/confidence and accepts an
optional CSS selector. Confirm price/currency before saving. Repair of the same
article preserves ID, history, goals and basket memberships; a different article
uses normal creation. Local failed-reading HTML stays in `.scrappy/readings/`.
Production `reading` dispatch needs `reading_id`; `product` needs `product_id`.
Both target `main`. Reading previews send no notices or production heartbeat;
`product` bypasses its interval and also evaluates basket alerts.

Individual goals trigger at/below target, repeat at an additional 5% drop and
rearm strictly above 103% of target. Both channels are attempted independently;
three consecutive reading failures mark error, and recovery restores active.
Failure reminders are limited to one pair of attempts per seven-day failure streak.
Basket goals require complete totals and rearm strictly above 103% of budget or
on a new budget/currency/composition. Ambiguous `claimed` events require manual
inspection before retrying. External delivery and DB writes cannot be atomic;
inspect receipts after interrupted runs rather than blindly sending again.
Statistics require 14 days and 10 complete snapshots per composition series.

For extractor diagnosis (network access, saved private HTML, no price persistence):

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.scrappy/browsers'
.\.venv\Scripts\python.exe -m scrappy.probe scraper/urls.txt --output .scrappy/local.json --state .scrappy/local-recipes.json
```

`--persist-recipes` additionally reads/writes Supabase domain recipes and needs
server environment values loaded as in the Windows wrapper. CSS is primary;
adaptive relocation (80% structural similarity) requires confirmation. Reports
include strategy/mode/confidence, response metadata and HTML hashes, without
request headers/credentials. Unsupported shops remain explicit failures.

For an existing database release, exclude Actions, API and local writers, record
installed migrations and take a private recoverable backup before SQL changes.
Migration files commit separately: stop on error and inspect the installed ledger.
Migration `20261011010000` removes `products.list_id` and renames basket fields;
old API/scraper code is incompatible. Publish matching API/web/scraper versions.
A frontend-only rollback cannot undo a schema migration. Prefer a reviewed
forward fix; restoring DB and matching code requires the owner's decision.
New work stays on `develop`; only the owner promotes to `main` (which can deploy).

Scheduler PAT expiry recorded by the owner: **2027-04-11**; rotation date
**2027-04-04**. Replace the dedicated token privately in cron-job.org, record the
new dates and revoke the old token. These dates do not prove a reminder exists.

## Global closure audit (2026-10-14 Lima, SPEC 14/15)

This is the authoritative remaining-work list. Historical records in STATUS and the private archive preserve provenance; their old pending items and authorization
gates do not reopen later accepted work or authorize a new production action.
This audit compared existing records only, without rerunning accepted tests or
querying/changing external services. On 14 Oct, the owner supplied the final
push confirmation below; no acceptance evidence items remain open in this audit.

| Final acceptance item | Evidence and completion record |
| --- | --- |
| Phone push with ntfy closed (SPEC 15) | Closed on 14 Oct 2026 by explicit owner confirmation: the previously accepted notification of 12 Oct at 11:53 a.m. Lima arrived with ntfy closed (not open on screen). Preserved private evidence `.scrappy/release-bfcf432/commission.json` records the ntfy test receipt `0f8ef619-11b8-4d14-b0c8-6cc5957e7f3d` at `2026-10-12T16:53:52.347927+00:00` and prior owner receipt confirmation. The closed-app condition is the owner's retrospective attestation, not provider telemetry. No new notifications or email/link/mobile UI tests were performed. |

The owner waived separate Supabase test-project integration on 14 Oct as
disproportionate for this personal project (SPEC 15). Both omitted opt-in tests
remain unexecuted, rather than passed; existing local and configured-project
evidence is retained. The preflight found only production and received HTTP 403
for organization metadata/entitlements. No separate project, migrations or test
fixtures were created; separate-project isolation and cleanup were not verified.
Earlier integration preflight pending items are superseded by this waiver. No additional project or credentials are required for this task.

Accepted evidence is retained: phase-one 15-URL local/Actions comparison (80% /
73.3%) and adaptive persistence; phase-two individual alerts/failure fixtures and
real channels; phase-three public HTTPS/authentication and physical PWA;
phase-five SQL/Python/API/web fixtures, migration conservation, basket alerts,
repair/history and local mobile visuals. The updated physical PWA was accepted
on 12 Oct, so the historical request for a later PWA update is closed; local
defer/apply/offline checks from 9 Oct also remain accepted. Public commissioning
on 12 Oct records the exact READY deployment/SHA, 31 read/auth checks and Actions
`all`/notification results. SPEC 14.1 separately closes six automatic slots,
real missing-heartbeat Gmail receipt and recovery; do not repeat any of these.

Store/release the final documentation and reviewed commissioning tools only after
the owner's decision about commits/promotion. This delivery decision is separate
from the completed acceptance audit above. The phase-four reproducible guide and Windows
fallback documentation are complete as recorded above. Native-cron diagnosis, broader shop coverage,
future PAT rotation and SPEC 17 backlog are maintenance/limitations, not new v1
closure gates. No new promotion, commit, deployment or production test occurred
in this audit. The private evidence referenced here must be retained separately
from Git before any workspace cleanup.


## Current automatic-operation mission (closed 2026-10-13 Lima)

SPEC 14.1 is complete. The owner approved the bounded fast window and existing
real main/all effects; all six NEW automatic slots were reconciled. The original
three-hour UTC cadence is enabled without expiry on job `8633587`, with approved
main SHA `63be2b508a1f791747dc3d1d2aba8656cdf4f812`. No new promotion was made.

| Planned Lima, 13 Oct | Provider execution | Actions run | Due checks | Snapshots |
| --- | --- | --- | ---: | ---: |
| 15:00 | 8633587-13-9-3 | 38459438701 | 2 | 1 |
| 15:10 | 8633587-13-9-4 | 38460704690 | 0 | 0 |
| 15:20 | 8633587-13-9-5 | 38462032784 | 0 | 0 |
| 16:00 | 8633587-13-9-6 | 38467364960 | 0 | 0 |
| 19:00 | 8633587-14-9-1 | 38487694031 | 0 | 0 |
| 22:00 | 8633587-14-9-2 | 38504058986 | 2 | 1 |

Each slot has its exact provider response, approved SHA/main/all identity,
successful job/processing/completion evidence, one distinct database run,
pre/post rows and due inventory, exact Decimal totals/microseconds, applicable
FX/basket/notification effects, and exactly one matching completion ping.
All six refreshed FX; eligible events/notifications remained unchanged. No
product interval/target was forced, no slot was manually dispatched or replayed,
and no historical run was counted. Provider delays were approximately 24–61
seconds; this is observed performance, not a punctuality guarantee.

The fast job was armed at 14:55:20 Lima with provider expiry at 15:21 and deadline
15:29. Its gate passed and the original schedule was restored/read back at
15:21:25. The three normal planned slots are exactly three hours apart. The
last gate passed at 22:02:23; the final audit independently rechecked every
slot, state chain, scheduler inventory, current main/workflow, and fresh DB/HC.

Real outage supervision was verified separately: a previously authorized failure
stop left the job disabled at 03:54:23 UTC, ping count 17 unchanged through the
new pre-slot capture. Healthchecks went down at 10:01:34 Lima, exactly 3h+9h after
last ping at 22:01:34 on 12 Oct. The owner confirmed the real Gmail alert at
10:01. New automatic run `38459438701` recovered it at 15:01:44. Period 10800 /
grace 32400 stayed unchanged; the final check is up with count 23.

The independent Windows observer was tested with 17 directed fixtures plus seven
existing Decimal/microsecond checks. It closed safely when GitHub returned an
empty steps array for successful normal run `38467364960`. Preserved pre/post
captures and exact timestamped successful job logs reconciled that slot with an
explicit alternate evidence source. A pre-activation resume also detected old
CP1252-decoded UTF-8 text and saved Decimal strings. Original captures were
retained with SHA256; one known reversible encoding layer was corrected and the
full state matched a fresh read before resumption at 16:10:12. No scheduled slot
was missed during that safety pause. UTF-8 decoding and saved/fresh exact numeric
comparison are now explicit; ambiguous/partial logs or real deltas still fail.

Ordinary operation needs neither Windows nor Codex: cron-job.org directly
invokes Actions; Healthchecks supervises the cloud completion ping. The observer
only captured commissioning evidence and controlled the test; all its processes
have exited. Both old Codex follow-ups are PAUSED. No accelerated schedule,
second scheduler, synthetic ping, reminder rehearsal or new paid service remains.
The native GitHub cron's historical failure cause is still unknown; the approved
external substitution does not require repairing it.

Free usage was checked: public repository, standard Ubuntu runner, cache
1,103,158,141 bytes (below 10 GB), six actual run durations totaling 271 seconds,
and GitHub-reported Ubuntu billable time 0 ms. The normal cadence invokes eight
runs/day. This is scoped service evidence, not a claim about unrelated account
billing. API reads were bounded around slots with a private ledger; earlier
account-wide API usage remains unknown. Dedicated PAT expiry/rotation dates
are recorded in the development reference; new main promotion is still the owner's decision.

Private evidence (ignored by Git): `.scrappy/mission-final-audit.json`,
`.scrappy/mission-window-20261013-a.json`, referenced per-slot/original-encoding
captures, `.scrappy/mission-outage-evidence.json` and observer logs. The final
report records exact database IDs, timing, current configuration and limitations.
`scripts/observe_operation.py` and `scripts/operation_api.mjs` are commissioning
tools, not a permanent local scheduler. Do not rearm an old proposal. The mission
exception in AGENTS is retired; normal project rules apply again.

## Acceptance evidence index

These are dated results, not instructions to repeat acceptance. Original reports,
private captures and STATUS history remain intact. Private `.scrappy/` files are
ignored by Git: preserve them separately before cleaning/moving this checkout.
The complete pre-cleanup README (including superseded proposals, diagnostics,
authorizations and detailed tables) is preserved with its source SHA256 in
`.scrappy/readme-before-cleanup-20261015.json`; it is a local provenance archive,
not a prerequisite for a new installation or authority to reactivate old trials.

| Scope | Result and retained evidence |
| --- | --- |
| Foundations, 8 Oct | Empty run connected/pinged: [37856046874](https://github.com/SRT0808/Scrappy/actions/runs/37856046874). |
| Extractor, 8 Oct | 15 URLs: local 12/15 (80%), Actions 11/15 (73.3%); JSON-LD 9/8, meta 3/3; local all HTTP, Actions Best Buy dynamic, none stealth-only. Reports: [local](scraper/results/local.json), [Actions](scraper/results/actions.json); [run 37857815799](https://github.com/SRT0808/Scrappy/actions/runs/37857815799). Raw HTML: `.scrappy/local-evidence/`, `.scrappy/remote/actions-evidence/`; remote artifacts originally retained seven days. |
| Extractor limits | Falabella empty offers/timeouts; Sercoplus 503; Impacto cash/card ambiguity; Ripley readable locally but Actions 403; Pimoroni GBP locally/USD remotely. Peruvian subset 4/7 local, 3/7 remote. Small sample, no universal coverage or isolated causal attribution. |
| Adaptive persistence | Versioned fingerprint restored in a fresh process, changed class/price relocated with confirmation; eight saved recipes, temporary integration rows removed. 26 affected tests plus graph-order regression; remote `68d32a9`, reviewed fix `6bb657c`. Existing evidence does not approve the later omitted separate-project integrations. |
| Individual alerts, 8 Oct | Controlled 100 PEN fixture, product `587d4cb6-2192-4252-acd6-064ad3c1d82a`: one sent goal notice per channel; second review sent none. Owner confirmed push/email, accents and link; product paused. Recovery SQL integration/manual review accepted. |
| Web/PWA, 9–10 Oct | Local 320/390px flows, update/defer/offline accepted; public HTTPS/auth/session and physical installed PWA accepted by owner on 10 Oct. Runs `38081645601` (notifications/heartbeat), `38081651363` (reading), release `1e7d765a293a466c7024db60d069b9bb5f7155be`. |
| Baskets/local closure | Four isolated PostgreSQL suites, 76 web, 43 API, 111 Python tests (two opt-in integrations omitted), build/typecheck and mobile visuals recorded in STATUS. Conservation, alert boundaries, repair/history and composition fixtures retained in repository tests. All 11 migrations installed; no replay. |
| Public commissioning, 12 Oct | Release `bfcf432cd823a2867b36ed2ecb3f26d8b4c17d8b`, READY deployment `dpl_3aMmpKuPNPfya6G4KqL9QRptdD2N`; 31 public smoke checks passed and updated physical PWA accepted. [All run 38280341687](https://github.com/SRT0808/Scrappy/actions/runs/38280341687): two checks, one snapshot and heartbeat; [notification run 38280514504](https://github.com/SRT0808/Scrappy/actions/runs/38280514504): both channels sent/received. `.scrappy/release-bfcf432/commission.json`. |
| Earlier restricted acceptance | 24 read/auth checks and restoration verified before public commissioning. `.scrappy/release-bfcf432/`: `restricted-results.json`, `restricted-data-verified.json`, `restricted-restored.json`, `restricted-exception-closed.json`, `maintenance-current.json`, `ready-deployment.json`; controlled-write/cleanup records remain in that directory and STATUS. Closed-access gates are historical. |
| Automatic operation/outage | Six reconciled slots, exact approved SHA, real Gmail absence and automatic recovery: mission record above and `.scrappy/mission-final-audit.json`. Earlier stopped windows, late Codex follow-ups and native-cron diagnosis are superseded operational history, retained in STATUS/private archive. |

No acceptance items remain open in the 14 Oct audit; separate-project integration
was waived, not passed. Final review of the closure package is complete; the owner's
commit/promotion decision remains pending. SPEC §17 backlog and broader shop
coverage are maintenance work, not v1 acceptance gates.

Final package review (15 Oct 2026, SPEC 14/15): manually reviewed the pending
six documentation/configuration files, three commissioning scripts and two test
files on `develop`. Resolved duplicate expected basket snapshots when multiple
members are due, with a positive fixture and duplicate-snapshot rejection; marked
the pre-closure SPEC 14.1 diagnosis as historical. No blocking findings remain
within this package. The 18 observer and seven precision tests, Node syntax,
six offline slot reconciliations and six evidence SHA256 hashes passed. Earlier
product/build/SQL and physical acceptance stand; no external acceptance was rerun.
The tools retain their fixed commissioning job/SHA and narrow successful,
native-currency, no-alert evidence scope; they are not general production monitors.
The package is ready for the owner's decision: documentation/configuration
(`.env.example`, `AGENTS.md`, `README.md`, `docs/SPEC.md`, `docs/STATUS.md`,
`docs/decisions.md`) and commissioning tools/tests (`scripts/observe_operation.py`,
`scripts/operation_api.mjs`, `scripts/verify_acceptance.py`,
`tests/test_operation_observer.py`, `tests/test_acceptance_verifier.py`).
No application, workflow or migration changes belong to this pending package.
Keep private evidence outside Git; no commit, push, promotion or deployment was
performed. This review does not assert current external service health.

## Phase 6 release candidate (deployed; legacy reopening blocked, 16 Oct 2026 Lima)

Current execution status is recorded after the recovery table below. The package
preparation and local acceptance paragraphs describe the earlier reviewed work;
they do not mean that the six migrations are still uninstalled.

This candidate isolates Phase 6 from base `7b660a1` on `develop`. All pending
application, SQL, fixture and documentation changes belong to this feature;
no unrelated working-tree changes were identified. The earlier final-package
section describes the already committed operational closure, not this candidate.
The exact file set is the candidate commit diff against that base.

The package includes six additive migrations `20261016000000` through
`20261016050000`, their matching guarded downs, engine/snapshot/recalculation/
notice modules, authenticated purchases API, local opt-in executor, web flows,
and their fixtures/regressions. Existing product/notification writers and their
tests are part of the same package: they now require the migration-provided
`mutate_product`, `record_notification` and `save_product_alert_state` RPCs.
Do not deploy those application changes independently of the SQL contract.
No dependency, environment variable, workflow or scheduler change is included.

Review uses the accepted whole-feature read-only review recorded below plus a
package-boundary check: matching up/down inventory, tracked import completeness,
no private evidence/secrets, no default local hook, no production worker/transport
wiring, and no activation route. Existing accepted tests/build/visual evidence
remain valid; packaging changes only README and STATUS and does not rerun them.

A future owner-authorized rollout must first exclude API, Actions and local
writers, preserve a recoverable database backup and apply the six ups in ascending
order before switching application writers. Reopen legacy operation only after
contract/regression checks. Alternatives stay inactive pending a separate decision
and an operational worker/transport integration; this candidate alone does not
complete that integration. Unused installation may use guarded downs in reverse
order while all writers remain excluded; publication/notice usage can forbid down,
so never force a rollback or delete its protection ledgers. No installation,
backup, activation, promotion, push, deployment or real delivery is performed here.

### Coordinated rollout and recovery for `1d2e5c0` (reviewed sequence; execution below)

Target: `1d2e5c0bc2d24f23f9a7541478c86dc50a605d4a`, based on `7b660a1`.
This is an execution sequence for a later owner-authorized maintenance window,
not authorization to run it. No remote state was inspected for this preparation;
the installed SQL ledger, live application SHA, access controls and backup
recoverability must be established at that window. Keep the existing three-hour
scheduler and Healthchecks 3h/9h configuration outside historical mission tests.
Promotion, installation, maintenance controls and reopening real legacy operation
need explicit scope from the owner. Alternatives activation and new real notice
tests remain separate decisions even after this rollout succeeds.

1. **Record the recovery baseline before touching production.** Privately record
   the current main SHA, serving deployment ID/SHA, installed migrations, workflow
   and scheduler enabled states, pending/running Actions and local processes.
   `7b660a1` is the candidate's Git base, not proof of the serving rollback target.
   Confirm the baseline schema includes migrations through `20261011040000` and
   reconcile any already installed Phase 6 prefix; never replay completed files.
   If actual SQL/code differs from the reviewed baseline, stop for reconciliation.
2. **Exclude and drain all writers.** Disable dispatch at both cron-job.org and
   **Check prices**; prevent manual/API dispatch too. Block public API access on
   the production alias and every credential-bearing deployment URL, including
   clients with existing sessions. Closing a browser or hiding a UI button is
   insufficient. Verify the access barrier before SQL; its exact provider control
   must be available and checked in the authorized window, not assumed from old
   private commissioning scripts. Stop Windows fallback, dev servers, local
   Python/review hooks and direct SQL clients. Drain active HTTP/DB requests and
   running/queued Actions, including runs checked out at the old SHA. Cancelling
   a run can leave partial writes or delivery ambiguity: reconcile runs, readings,
   events and channel receipts before proceeding. The SQL gate and Actions
   concurrency group do not exclude old code or external channel requests.
   Keep Healthchecks active; record maintenance time and possible absence alerts;
   do not send synthetic heartbeats or repeat the closed outage mission.
3. **Back up the quiescent database.** Preserve schema, data, function definitions,
   grants and the installation ledger privately with an available restore method;
   verify the backup is readable/restorable in isolation before proceeding.
   Record legacy IDs, memberships, quantities, prices, histories, alert latches,
   composition versions and totals at a fixed timestamp for later comparison.
   No backup or restore is performed by this preparation.
4. **Install SQL before any candidate writer can run.** Execute the six complete
   files individually, recording each successful COMMIT in the private ledger:

   | Order | File in `supabase/migrations/` | Contract added |
   | --- | --- | --- |
   | 1 | `20261016000000_purchase_shadow.sql` | Additive graph/backfill; mode stays legacy |
   | 2 | `20261016010000_purchase_persistence.sql` | Gate, runtime, capture and evaluation |
   | 3 | `20261016020000_purchase_writers.sql` | Gated legacy RPCs, new writers and revoked direct grants |
   | 4 | `20261016030000_purchase_publication.sql` | Versioned configuration publication |
   | 5 | `20261016040000_purchase_notices.sql` | Evaluation events and channel receipt state |
   | 6 | `20261016050000_purchase_api.sql` | Configuration/history read RPC |

   Each file has its own transaction; the six files are not one atomic release.
   On error or uncertain COMMIT, keep exclusion, inspect actual objects/ledger and
   determine the committed prefix before any retry. Do not append a COMMIT to a
   failed transaction or run the whole directory again. Confirm PostgREST exposes
   the final RPC signatures and isolation settings after its schema reload.
5. **Check SQL and switch matching code while access remains blocked.** Compare
   the conservation baseline, all lists still `legacy`, empty publication/notice
   usage ledgers, empty evaluations/events/deliveries, and the singleton gate.
   Inspect RLS, denied direct service writes/private schema access, allowed RPC
   execution and wrapper SERIALIZABLE metadata against the migration files.
   Do not call `enter_purchase_operation` as a read-only probe: it writes a fence.
   Only after SQL checks may the owner promote the reviewed candidate to main and
   deploy matching API/web; promotion may trigger deployment automatically.
   Verify the serving deployment's source SHA and that future Actions checkout
   the same main SHA. Record any approved documentation-only descendant explicitly.
   Old deployed writers cannot safely resume after the direct grants are revoked.
6. **Separate harmless checks from controlled writes.** Through the restricted
   operator path, check anonymous session denial, authenticated catalogs, legacy
   totals/detail and GET purchases (including legacy mode/history pagination).
   Reading a legacy purchase configuration does not activate it; PUT cannot switch
   a legacy basket to alternatives. Before reopening writers, the separate
   execution scope must also cover a controlled legacy RPC round trip through
   deployed PostgREST to verify actual SERIALIZABLE behavior, CAS/conflict handling
   and matching API/Python persistence. Use isolated fixture identities, compare
   affected state and reconcile/clean up precisely; never use notification tests,
   `all` or `product` as supposedly harmless probes. They can scrape, write, send
   real alerts and ping Healthchecks. Unit/local SQL evidence does not establish
   deployed PostgREST behavior. A 409/isolation error stops reopening; no blind
   retry of a mutation, review or delivery is allowed.
7. **Reopen legacy operation only after the execution checks pass.** Preserve
   legacy mode everywhere and leave the alternatives worker, local callback and
   notice transport disconnected. Restore only the previously authorized API,
   workflow and single scheduler states, after stale queues are resolved. Observe
   the next ordinary slot: main SHA, run completion/counts, persisted checks,
   legacy snapshots/receipts and genuine heartbeat. Do not dispatch catch-up runs
   or accelerated slots. Record the outcome and any partial/ambiguous delivery;
   activation requires a later reviewed worker/transport and explicit decision.

**Recovery decision points (all writers stay excluded until reconciled):**

| Failure boundary | Recovery |
| --- | --- |
| Before the first SQL COMMIT | Keep baseline code/schema; reopen only after confirming no changes or outstanding writers. |
| Partial SQL prefix, before candidate code | Inspect committed prefix. Prefer completing a reviewed forward fix. If unused and owner-authorized, run only matching committed downs, descending; never invoke absent objects' downs. |
| All SQL installed, deployment or contract check fails | Keep the API blocked and scheduler/workflow stopped; repair forward with matching code. Reverting only the frontend or serving old API/Python against revoked direct grants is insufficient. |
| Unused installation is to be reversed | With exclusion, use matching files in `supabase/rollback/`, timestamps `20261016050000` → `20261016040000` → `20261016030000` → `20261016020000` → `20261016010000` → `20261016000000`, in reverse dependency order. Each COMMIT is independent. Restore and verify the recorded baseline API/web/main execution target before any old writer resumes. |
| A down refuses, publication/capture/notice usage exists, or state is uncertain | Stop reversal. Preserve v2 graphs, evaluations, receipts and internal protection ledgers, including deleted-list publication evidence. Keep writes blocked; use a reviewed forward repair. Never reset mode, remove a ledger, use CASCADE manually or flatten history to bypass a guard. |
| Restore is chosen by the owner | Restore the quiescent backup and matching code as one recovery operation. Reconcile every later write and channel receipt first; a database restore cannot retract external messages and can make sent events appear pending. Never automatically resend or reclaim ambiguous/claimed deliveries. |

The downs are documented as local/pre-activation recovery and have only local
fixture evidence; their presence is not production restore approval. This review
checked the sequence against the six actual ups/downs, API mode guard, writer
callers and workflow. It ran no SQL, provider operation, HTTP probe or delivery;
previous accepted suites/build/visual checks were retained without repetition.

### Authorized execution: SQL/application verified, initial reopening stopped

On 16 Oct 2026 Lima, the owner authorized resuming the full rollout at red level.
The quiescent backup restored in an isolated PostgreSQL instance with all 13
public tables and 162 rows matching. All six migrations committed individually;
their hashes and commit confirmations are recorded privately. Original rows,
memberships, histories, latches, composition versions and fixed-time basket totals
were conserved; RLS, grants, private schema denial and wrapper isolation metadata
passed. There was no pre-existing database migration table: the private release
ledger records this installation without inventing a Supabase ledger.

Remote main and develop were promoted to exactly
`1d2e5c0bc2d24f23f9a7541478c86dc50a605d4a`. Production deployment
`dpl_9qkx5RurbBL45kvaUryM11y9BgNq` reached READY from that Git source.
Its build passed; 16 restricted HTTP reads covered authentication, catalogs,
legacy detail, purchases pagination and PWA assets. Seven legacy API operations
proved editing, quantity changes and stale-version rejection without extra writes.
The actual Python Database.save_review transport persisted a synthetic review
through deployed PostgREST; a stale replay was rejected without another history
row, and the deployed API returned the updated price/total. These successful
gate-first RPCs establish actual SERIALIZABLE execution, beyond metadata alone.
No scraping, notification transport or test dispatch was used. Fixtures were
removed and all original rows and fixed-time totals compared equal again.

Execution stopped after two failed checks, under AGENTS.md. The first raw probe
received Vercel authentication's 302 before WAF; authenticated vercel curl then
passed 18 exclusion checks over five aliases and four ready deployments, with
and without a valid application session. The second failure occurred while
narrowing maintenance to `/api` on retired deployment hosts: the production alias
returned 403 instead of the expected anonymous 401. Configuration was recorded;
propagation versus host-condition behavior is not yet established. No reopening
retry or further functional repair was attempted.

**State at the initial stop (superseded below).** The global maintenance barrier was restored and
verified with valid sessions against the production alias and candidate URL.
Cron-job.org job 8633587 is disabled, Check prices is disabled_manually, and no
Actions or other client transactions remain active. Healthchecks was unchanged;
the application and ordinary scheduled reviews remain unavailable until reopening
is resolved. Every basket remains legacy; evaluations, purchase events/deliveries
and publication/notice usage ledgers are empty. The gate fence is 15 from the
controlled successful operations and must not be reset. Alternatives worker,
callback and transport remain disconnected. The first ordinary candidate slot
has not been observed. Do not replay migrations or restore only the old API.

Private evidence: `.scrappy/release-1d2e5c0/red/`, especially `migrations.json`,
`sql-verification.json`, `application-read-passed.json`, `legacy-api-write-passed.json`,
`python-persistence.json`, `legacy-python-api-passed.json`, `cleanup-passed.json`,
`reopening-firewall-at-stop.json`, `stopped-verification.json` and `backup/`.
At that stop, continuation required the owner's decision after the red-level failure: diagnose
the reopening response, exclude retired API writers, prove public and authenticated
access, then restore only the original workflow/job states and three-hour schedule.

### Authorized reopening completed (17 Oct 2026 Lima)

The owner authorized continuing at red level. Fresh read-only checks confirmed
the candidate SHA/deployment, stopped workflow/job, global barrier and inactive
alternatives before changing access. The maintenance rule was narrowed to `/api`
on the 18 retired deployment/alias hosts, preserving every unrelated firewall rule.
The production alias returned application 401 after 1,382 ms on the first
post-change sample. Four current hosts (three aliases and the candidate URL)
each returned 401 anonymously and 200 with a valid application session; four
retired READY deployments and two retired aliases returned WAF 403 even with a
valid session. The public home and authenticated list catalog returned 200.
The previous 403 did not recur; its cause remains unproven, so this evidence does
not establish a provider propagation guarantee or a host-condition defect.

Legacy access, Check prices and cron-job.org job 8633587 were restored by
00:01:58 Lima. The job's original three-hour UTC schedule, dispatch payload and
other settings compared equal; no catch-up/manual dispatch was sent. The next
ordinary slot is 17 Oct at 01:00 Lima (06:00 UTC), still pending observation.
Main/deployment remain exactly `1d2e5c0`; no code promotion, migration, backup,
fixture write, scraping or notification test was repeated. Healthchecks was
unchanged. Both baskets remain legacy, evaluations/events/deliveries and
publication/notice usage remain empty, and the gate fence remains 15.
Alternatives worker, local callback and notice transport remain disconnected.

Private evidence in `.scrappy/release-1d2e5c0/red/`:
`reopen-resume-baseline.json`, `reopen-resume-barrier.json`,
`reopen-reviewed-change.json`, `reopen-propagation-samples.json`,
`reopen-api-passed.json`, `reopen-before-scheduler.json` and
`reopen-final-verification.json`. Reopening is verified.

The first ordinary slot, 17 Oct 2026 at 01:00 Lima (06:00 UTC), is reconciled:
provider receipt `8633587-17-9-3` identifies successful Actions run `39008340533`,
attempt 1 on main at the exact candidate SHA. Captures at 00:55 and 01:02 Lima
show one new completed DB run (`6c2001d2-7ad9-4407-a612-abf38cf1157c`), zero due
products, zero reviews, and an FX refresh. Products, prices, basket snapshots,
events and notification receipts are unchanged; no new extraction or delivery
is claimed. The successful heartbeat step matches Healthchecks at 01:01:36 Lima,
with its counter increasing from 47 to 48 and the original 3h/9h settings intact.
Both baskets remain legacy and alternatives evaluation/event/delivery/publication/
notice usage tables remain empty. Cron schedule/payload and active workflow are
preserved. The observer exited; no manual dispatch, SQL replay, accelerated test
or alternatives activation occurred. Private evidence: `ordinary-reconciled.json`,
`ordinary-before.json`, `ordinary-after.json`, `ordinary-provider.json`,
`ordinary-actions.json` and `ordinary-job.private.log` in the same directory.
Alternatives activation and worker/callback/transport integration remain separate
owner decisions; the closed mission tests must not be restarted.

## Alternatives integration and activation scope (defined, inactive; SPEC 14/15)

Defined on 2026-10-17 (Lima). This is the plan for subsequent implementation and
acceptance, not an activation procedure ready to execute. The latest recorded
baseline is candidate `1d2e5c0`, two legacy baskets and the reconciled ordinary slot
above; no fresh remote health check is claimed. Existing local acceptance remains
valid. Deployment installed the schema/application, but did not connect the worker,
local callback or delivery transports. `PUT /api/baskets/:id/purchases` requires
alternatives mode and cannot perform the initial conversion.

### Scope and dependency order

| Stage | Deliverable and prerequisites | Completion boundary |
| --- | --- | --- |
| 1. Bounded worker, offline | Compose `recalculatePendingPurchases` and `deliverPurchaseNoticeLocally` with injected exclusive connections, channel callbacks and clock. Discover pending deliveries independently of new evaluations. Reuse existing capture/commit/claim/finish contracts. | Temporary PostgreSQL fixtures and fake senders only; no default startup hook, environment reads or live connection. |
| 2. Runtime adapters and local callback | Supply a real PostgreSQL session adapter, general Spanish ntfy/email message adapters, and explicit opt-in wiring to `localReadings`. Reuse the stage-1 worker for `afterProductReview` and `recover()`. | Local integration with fixtures, fake provider endpoints and temporary DB; defaults remain disconnected. |
| 3. Atomic activation contract/API/UI | Add a service-only gated activation RPC, authenticated API and explicit per-basket confirmation, with the conversion rules below. Depends on a recoverable worker and mixed-mode UI/read/write guards. | Local conversion/concurrency/auth tests and one visual verification of the changed activation screen; real baskets remain legacy. |
| 4. Operational wiring and review | Add a Node worker invocation to the existing Actions job after Python review modes `all`/`product`, including zero due products and a Python failure after durable writes. Keep `reading`/`test_notification` outside this path. | Test workflow ordering/failure/heartbeat contracts offline, run affected checks/build and final review; present an exact develop candidate for the owner's main decision. |
| 5. Authorized deployment and activation | After local acceptance, owner decides exact promotion, operational connections, basket IDs/configurations, enabled notice settings and real-send scope. Deploy the compatible worker/adapters/activation path before converting any basket. | Read back configuration and reconcile attributable ordinary-run effects; no accelerated mission or new outage rehearsal. |

Stage 1 is the next implementation task; stages 2–5 depend on its acceptance.
Stage-1 offline acceptance is complete (2026-10-17 Lima): `purchase-worker.ts`
adds injected connections/channels/clock, separate 25-item cursor sweeps, a
cooperative 180-second deadline, channel timeouts and durable recovery. Runtime
adapters must honor the injected connection/query budgets; no default wiring or
live connection exists. Nine worker unit tests and eleven affected regression
tests were previously accepted; current typecheck passed. The psql bridge now
closes idempotently, handles stdin errors and represents SQL NULL explicitly,
preserving a row when a channel is already claimed. Seven temporary PostgreSQL
groups passed, including concurrent workers without duplicate sends, terminal
channel outcomes and lost durable claim/finish acknowledgements. The eighth
group now passes deadline/recovery and conservation against the fixture baseline,
including its seven pre-existing legacy snapshots, instead of absolute totals.
Only that pending group was executed in this closure, with minimal fresh fixture
setup: `$env:PURCHASE_WORKER_LOCAL='1'; $env:PURCHASE_WORKER_FROM='8'; node tests/purchase-persistence-sql.mjs`.
The prior seven groups and twenty unit/regression tests retain their acceptance;
they were not rerun. Manual code review of the stage-1 worker, shared helpers,
psql bridge and tests found no blocking findings; diff-check passed. Runtime
adapters must still enforce actual timing/TLS/role constraints in stage 2.
The closure's temporary cluster was stopped and removed by cleanup; the older
private diagnostic fixture remains under `.scrappy/purchase-persistence-pg-qSGVxF/`.
No real sends, activation, runtime adapters or callback wiring were performed in stage 1.

### Stage 2 offline acceptance (2026-10-17 Lima)

`purchasePostgres` now supplies a fresh exclusive `pg` session per worker sweep.
It requires an explicit SQL URL with credentials and no query options, verified
TLS (optional PEM CA), a dedicated NOINHERIT login with no ownership/elevated
attributes, and only non-inheriting, non-admin membership with SET access to
`service_role`. Startup verifies the login and assumed role. Connection is bounded
to 5s, SQL to 2s or the remaining worker budget, and close to 2s with socket
destruction. Client timeouts disconnect rather than reuse uncertain sessions;
existing transaction helpers retain SERIALIZABLE/rollback behavior. Nonempty
startup options prevent accidental PGOPTIONS inheritance. The explicit
`localFixture` escape disables TLS only for numeric loopback temporary databases.
Role membership options require PostgreSQL 16+; deployed login/pool compatibility
and actual certificate/privilege checks remain deployment prerequisites.

`purchaseTransports` takes explicit configuration and optional provider doubles.
The default ntfy/Gmail transports verify HTTPS/TLS and use the worker's abort
signal/15s budget; SMTP closes on cancellation. Spanish notices identify the
frozen event, exact configuration version and evaluation timestamp, label it as
historical, and link to the current basket on a validated HTTPS application
origin. Provider acceptance is `sent`, definite rejection `failed`, and uncertain
or timed-out delivery `ambiguous`; this does not prove device receipt. The only
alternatives receipt authority remains `purchase_deliveries`.

`localPurchaseRuntime(root, { connect, channels, now })` explicitly composes these
adapters with the stage-1 worker and `localReadings`: product-child completion
invokes the worker even on a nonzero exit; `recover()` is explicit and coalesces
with an active callback. Construction performs no connection or recovery. Vite
continues using its original disconnected executor. To opt in later, supply
`connect: purchasePostgres({ databaseUrl, ca })` and
`channels: purchaseTransports({ appOrigin, ntfyTopic, gmailUser, gmailPassword, emailTo })`.
The optional PURCHASE_DATABASE_URL/CA and PURCHASE_APP_ORIGIN names are reserved
in `.env.example`; callers must map them explicitly, only in authorized local
runtime/Actions. No worker credentials belong in Vercel or browser bundles.

Acceptance: ten distinct adapter unit tests and six distinct temporary PostgreSQL
groups passed, including real `pg` transactions/privilege failures, bounded
connection/SQL/close behavior, fake HTTP/SMTP acceptance/rejection/timeouts,
overlap, child failure after durable review and recovery after callback outage.
Price checks increased only for the two fixture reviews; legacy snapshots and
notifications matched their baseline. Revalidation after driver hardening ran
only affected groups; the provider-only group retained its earlier acceptance.
Commands: `npx tsc`, then `node --test .scrappy/api-build/tests/purchase-adapters.test.js`;
for the temporary database, set `$env:PURCHASE_ADAPTERS_LOCAL='1'` and run
`node tests/purchase-persistence-sql.mjs` without loading `.env`. The
PURCHASE_ADAPTERS_MATCH test-only regex can select affected groups.
Manual review found no remaining blocking findings; the temporary cluster was
stopped/removed. No remote connection, real sends, activation, workflow change,
default callback, deployment or promotion was performed. Stages 3–5 remain pending.

### Stage 3 offline acceptance (2026-10-17 Lima)

Atomic per-basket activation is accepted locally: service-only preview and
activation RPCs rebuild current legacy memberships, check composition version
and source fingerprint, publish version +1 and store a durable request receipt.
Authenticated GET/POST routes and the confirmation screen require explicit notice
choices; uncertain responses are reconciled by receipt readback without automatic
mutation retries. Empty baskets require an explicit valid graph. Rollback refuses
to discard activation receipts; recovery requires compatible code or forward repair.

All six temporary PostgreSQL activation groups are accepted across the recorded
runs. This closure ran only the pending sixth group:
`$env:PURCHASE_ACTIVATION_LOCAL='1'; $env:PURCHASE_ACTIVATION_FROM='6'; node tests/purchase-persistence-sql.mjs`.
Its conservation baseline is captured inside the legacy writer transaction after
the quantity edit (2 to 3), including its legitimate snapshot. The rejected stale
confirmation, fresh activation and refused rollback preserve that complete baseline,
including basket items, products, price checks, legacy snapshots and notifications.
The temporary cluster was stopped and removed by cleanup.

Previously accepted evidence remains valid without rerunning unchanged checks:
nine API tests, six activation UI tests, 23 web regression tests, both typechecks,
build/PWA and local visual confirmation at 320/390 px (`.scrappy/activation-visual`).
Manual closure review covered migration/rollback, gate/CAS and receipts,
session/origin guards, explicit UI confirmation, ambiguous-response recovery and
mixed-mode integration; no blocking findings remain. Diff-check passed.
Changes remain uncommitted on develop. No remote connection, real basket activation,
real send, deployment or promotion occurred. Stage 4 operational wiring and offline
workflow review was completed in stage 4 below; stage 5 and any main promotion
require the owner's decision.

### Stage 4 offline acceptance (2026-10-17 Lima)

The existing `check-prices.yml` job now builds and invokes
`scripts/purchase-actions.ts` after Python `all`/`product` reviews, including an
empty due-product set and a failed review that may have committed prices.
Explicit status conditions allow recovery after Python failure without changing
its failed outcome. Node setup/build/worker failures prevent the success heartbeat
and reach the existing failure ping. `reading` and `test_notification` skip this
runtime; existing heartbeat behavior, main guard, concurrency and cadence remain.

The Actions repository **variable** `PURCHASE_WORKER_ENABLED` must equal `true`
to enable these new steps. It is unset/disabled by default and was not changed
remotely. Stage 5 must provision the dedicated login and verify TLS/pool/role
compatibility, then configure Actions secrets `PURCHASE_DATABASE_URL`, optional
PEM `PURCHASE_DATABASE_CA`, and HTTPS `PURCHASE_APP_ORIGIN`, reusing the four
existing notice secrets. Never place these SQL credentials in Vercel/the browser.
The explicit CLI checks the flag/mode before constructing adapters, performs a
durable recovery sweep, reports counts/backlog, and exits nonzero on infrastructure
failure with a sanitized Spanish error. Imports perform no runtime work.

Offline acceptance: five Node tests passed, covering CLI gates and sanitized exit,
both review modes with zero reviewed products, independent delivery discovery
after infrastructure failure, and the actual workflow expressions across modes,
gate states and Python/setup/build/worker failures. TypeScript and full web/PWA
build passed. Earlier stage-1/2/3 fixture acceptance remains valid, including a
Python child failing after durable writes and restart without duplicate sends;
unchanged suites were not repeated. Manual final review covered workflow status
propagation, secret scoping, runtime composition and activation dependencies with
no blocking findings. No Actions run, live connection, send, basket activation,
deployment or promotion was performed. The accepted changes are packaged on
develop; see the stage-5 candidate below for the exact code revision.

The Python scraper remains the only price-review engine. The TypeScript worker
uses persisted prices/FX and never dispatches readings or scrapes URLs. Product
alerts and legacy snapshots/receipts retain their existing owners. No new scheduler,
paid service, automatic offer discovery or second implementation of the optimizer.

### Worker, connection and delivery contracts

- Each worker invocation performs one UUID-cursor recalculation sweep, pages of
  25 baskets, then a separate delivery sweep, pages of 25 events ordered by
  their archived evaluation time and event ID (join the matching evaluation;
  events have no creation-time column). Discover events with at least one **pending
  channel**, not merely newly committed evaluations or the aggregate event status.
  Restart discovery from the beginning on the next invocation; no in-memory queue
  is authoritative. A conflict/deferred basket does not prevent later IDs or
  already-pending notices from progressing. Callback overlap coalesces as in
  `localPurchaseReviews`; recovery starts with a new connection and fresh capture.
- Bound each invocation to 180 seconds, checking the deadline between items and
  before channel claims; transport timeouts are at most 15 seconds and a channel
  starts only with enough remaining time to finish/record it. Stop discovery at
  the deadline and report remaining work; never kill and automatically replay a
  claimed send. Backlog remains durable for the next ordinary run. Tests must
  prove these bounds and later-ID progress; operational timing must fit the
  existing 20-minute job limit before deployment. Conflicts/backlog are reported;
  connection/discovery/receipt failures fail the worker step. Valid incomplete
  comparisons are business results, not infrastructure failures.
- Preserve a single exclusive PostgreSQL connection across each SERIALIZABLE
  transaction, with parameterized queries, verified TLS outside local fixtures,
  bounded connect/query timeouts, rollback and close on every exit. Stage 2 may
  add `pg` as the necessary Node runtime driver; stage 2 installed it offline.
  Use a dedicated server-only `PURCHASE_DATABASE_URL`, separate from migration
  credentials, for a login restricted to the existing service-role contract;
  never use the database owner for the worker. Pool/role compatibility and least
  privileges are deployment prerequisites. A REST service key is not a SQL login,
  and separate PostgREST requests cannot replace this transaction connection.
  Update `.env.example` and secret placement when implementing the adapter:
  worker credentials belong only in authorized local runtime/Actions, never the
  browser or Vercel API. No account or secret is needed for stage-1 fixtures.
- Reuse ntfy/Gmail accounts and `nodemailer`; extract/generalize transport code
  where useful without changing existing test/product notifications. Existing
  Settings functions send a fixed test payload and cannot directly send purchase
  notices. Require a validated application origin for the basket deep link;
  include event identity, configuration version and evaluation time in Spanish
  messages. Discover frozen pending events across versions as historical notices,
  clearly dated, without presenting them as the current recommendation or silently
  discarding them. Recipients can inspect the current basket through the link.
- Claim each channel durably before sending. Only confirmed provider acceptance
  yields `sent`; definite rejection yields `failed`; timeout, uncertain acceptance
  or unclassified error yields `ambiguous`. A lost claim acknowledgement prevents
  sending; a lost finish acknowledgement prevents replay. Never reclaim `claimed`,
  `failed` or `ambiguous` automatically. Continue the other channel independently
  and expose receipts for operator inspection. Keep `purchase_deliveries` as the
  sole alternatives receipt authority; do not call Python `deliver()` or create
  duplicate legacy `notifications`. Provider acceptance and device receipt are
  separate evidence; no exactly-once receipt guarantee is claimed.
- In Actions, the worker runs after review completion even if Python failed;
  the original Python failure must remain a failure. Success heartbeat follows
  both successful steps, and the existing failure ping covers either failure.
  Do not send a success heartbeat for failed discovery/receipt persistence.
  `reading` keeps its existing heartbeat exclusion. Keep cron payload/cadence,
  job concurrency, main guard and Healthchecks 3h/9h configuration unchanged.

### Per-basket activation and recovery

Activation requires a new atomic operation, not a bare `purchase_mode` update or
a call to the existing alternatives-only PUT. Under the gate/list locks and
SERIALIZABLE isolation, compare the expected legacy composition version, rebuild
the shadow from current memberships, validate limits/units/graph and preserve IDs,
quantities, product history, references and legacy observations. Publish the
confirmed graph as version +1, switch mode and invalidate the evaluation together.
The confirmation shows preserved configuration, resulting needs/offers and notice
settings. Notice settings require explicit selection: a first qualifying budget
evaluation may send; the first verified winner establishes a baseline without a
winner-change notice. Do not assume that conversion is notification-free.

Use a durable activation request identity/receipt so a lost successful response
can be reconciled by authenticated readback without a second version advance.
Reject stale or competing edits with 409; invalid/oversized conversion leaves the
whole legacy basket untouched. There is no bulk or automatic activation. Empty
baskets require a valid explicitly confirmed graph, not fabricated purchases.
Legacy and alternatives baskets must remain usable together, including shared
trackers, confirmation/repair guards and all non-winning offer dependencies.

After conversion, recovery pauses the alternatives worker/senders and affected
configuration writes while preserving readable versioned data and receipts.
Restore the last compatible application/worker or repair forward; do not reset
mode, flatten combos, drop migrations or clear claim/baseline/history to retry.
Individual/legacy operation may continue only with compatible guards. Outstanding
claimed/ambiguous deliveries need inspection; restarting discovery never resends
them. Any production restore or expanded real-send scope needs its own decision.

### Validation gates (planned, not executed by this definition)

| Gate | Minimum new evidence |
| --- | --- |
| Worker offline | Unit orchestration plus temporary PostgreSQL: no due products but pending config/FX/day work; pagination/deadline and failing early UUID; crash after evaluation before delivery; old-version pending event; concurrent workers, partial channels, lost claim/finish responses and restart without duplicate evaluations/sends. |
| Adapters/callback | TLS/role/transaction adapter tests; fake ntfy/SMTP acceptance, rejection and timeout; basket link/version/date rendering; failed child after saved review, overlap and restart recovery; no extra price checks or legacy receipts. |
| Activation | Conservation at fixed price/FX, version +1 exactly once, stale CAS and concurrent membership/review edit, lost response/readback, invalid/oversized graph, disabled notices versus first budget event, first-winner baseline, auth/RLS and mixed legacy/alternatives regression. |
| Local release | Affected tests and build, activation screen visual check, workflow success/failure/heartbeat ordering and final `/review`; retain prior SPEC 15 evidence without repeating unchanged suites. |
| Authorized operation | Verify runtime credentials/access and exact deployed SHA first; record chosen basket IDs, before/after version/config and conservation. Reconcile an ordinary run with worker counts, current evaluation/archive, applicable event/channel receipts and genuine heartbeat. Zero eligible events cannot prove transport delivery; use separately authorized real sends and owner receipt confirmation when applicable. Keep free-usage/time evidence and pending limitations explicit. |

No implementation, activation, credential/configuration change, remote request,
notification, commit or promotion is performed by this definition task.

## Phase 6 local acceptance (SPEC 14/15)

Acceptance matrix consolidated on 2026-10-16 (Lima). Earlier module sections below
are historical implementation records; their pending milestones are superseded
only by the acceptance evidence in this matrix and the latest STATUS entry.

| SPEC 15 case | Local evidence |
| --- | --- |
| Four bottles S/11.20 versus S/12; litre S/2.60 versus S/3; repeated two-bottle packs and a one-pack limit | `tests/purchase-engine.test.ts`: whole presentation prices, exact quantities, fallback and infeasible result. Two new `SPEC 15:` cases passed at closure; existing motor cases remain accepted. |
| Shared S/5 combo versus S/5.30; overlapping scopes and global versus per-line minimum | Motor shared-charge/pin cases and independent exhaustive oracle over 200 configurations; aggregated offer limits. |
| Surplus, accepted extras, incompatible units and undeclared equivalences | Motor quantity/coverage rejection and publication graph validation; existing PostgreSQL publication acceptance. |
| Combo versus component failure, suspicion, unavailable/unconfirmed/missing price, expired FX and recovery | New motor state/dependency matrix passed for both offers; existing SQL capture/recalculation and real offline Python review integration cover durable failure/recovery and invalid pins. |
| First/third failure, weekly reminder, individual identity and shared dependencies | Existing `scraper/tests/test_alerts.py` first/third/weekly boundaries and product-owned receipt tests; writer/recalculation SQL shared/standalone/legacy dependency cases and review integration check counts. These compose the evidence; no real delivery was tested in Phase 6. |
| More expensive/failed/incompatible pins, stable ties and independent recommendation | Motor pin, ordering and reference cases; SQL notices suspend budget for invalid pins; accepted UI displays both selections. |
| Winner threshold, exact boundary, baseline/version reset, current valuation, concurrent transition and combined budget event | Twelve accepted PostgreSQL notice groups in `tests/purchase-notice-cases.mjs`; below-threshold changes advance the baseline without a notice. |
| Both channels fail, partial/ambiguous delivery, lost claim/receipt response and no replay | Same notice groups plus sender unit cases; all senders are explicit local callbacks. |
| Reference comparability/zero denominator, decimal FX/rounding, integer counts, no solution and resource cutoff | Motor exact-decimal/bounds/reference cases and versioned snapshot/CLI replay tests; incomplete/unproven states remain explicit. |
| Legacy totals/metas/history/IDs, independent products, RLS/auth and version isolation | Accepted shadow up/down/conservation SQL; capture/writer/publication/API groups; API auth/CAS/error tests and affected Python regressions. |
| Local UI and review-to-recalculation flow | Nine accepted purchase UI cases; 18 Edge checks at 320/390 px (`.scrappy/purchase-visual/`); six executor unit cases and three temporary PostgreSQL/offline child groups, including restart/outage recovery without extra scraping. |

Closure validation: `npm run build` passed, including both TypeScript projects and
PWA generation. The first closure pass added two `SPEC 15:` tests, including 12
failure scenarios and recoveries. After correcting the review findings, all 22
affected motor/snapshot tests and all 24 affected purchase/home web tests passed.
The motor still matches the independent exhaustive oracle. Other previously
accepted SQL/API/Python/executor suites remain accepted without rerunning.

Six additional Edge checks at 320/390 px verified direct notice navigation,
the unsupported-currency exclusion and a failed summary refresh; no horizontal
overflow, JavaScript errors or non-GET requests. Evidence/script:
`.scrappy/purchase-visual/fixes-results.json` and
`.scrappy/purchase-visual-fixes.mjs`. Earlier visual acceptance remains recorded.

```powershell
npx tsc
node --test .scrappy/api-build/tests/purchase-engine.test.js .scrappy/api-build/tests/purchase-snapshots.test.js
npm run test:web -- tests/web/Purchases.test.tsx tests/web/HomeScreen.test.tsx
```

The initial mandatory whole-change review found three P2 issues (private output
`.scrappy/phase6-final-review.log`). Their corrections are now tested:

- Unsupported offer currencies are explicit exclusions; valid alternatives still
  compete, invalid pins stay incomplete, unused drafts do not abort evaluation,
  and archived results replay. Basket currencies remain PEN/USD.
- Summary refresh clears prior data/errors before requesting validity; failures
  cannot retain a previously valid total, and aborted responses cannot restore it.
- `HomeScreen` opens the unique validated `/?basket=<uuid>` destination after
  session establishment. Invalid/duplicate destinations are ignored; leaving the
  breakdown clears this query parameter while preserving unrelated URL state.

The follow-up whole-change review confirmed the three original corrections and
found two further P2 issues in `PurchaseBasketScreen.tsx` (private output:
`.scrappy/phase6-corrections-review.log`). With owner-approved red escalation,
both are now corrected:

- Initial loading, consultations and saving share one operation guard. Cleanup
  aborts obsolete operations; late successes, errors and finalizers cannot
  overwrite the current data, draft, base version or busy state, including
  StrictMode and basket changes.
- Normal and paginated consultations invalidate the cached evaluation before
  requesting data. Failures preserve the draft and receipts without displaying
  old totals as current. A cross-version page also requires consultation before
  loading a version or saving; explicit recovery restores verified results.

The first red review confirmed those fixes, then found missing product-catalog
recovery (`.scrappy/phase6-red-review.log`). Initial loading and explicit normal
consultation now load the catalog inside the same abortable operation, retry
failures and refresh products added elsewhere without replacing the draft.

All 23 purchase UI tests passed, including twelve new concurrency, validity,
catalog and recovery cases. Build, both TypeScript projects and PWA generation
passed. Fourteen additional Edge checks at 320/390 px covered initial loading,
catalog and normal/paginated failure/recovery with the edited draft intact; screenshots were
inspected, with no horizontal overflow, JavaScript errors or non-GET requests.
Evidence/script: `.scrappy/purchase-visual/detail-results.json` and
`.scrappy/purchase-visual-detail.mjs`. Earlier accepted suites were not repeated.
The final red whole-change review completed with no blocking findings, confirming
all five prior fixes, catalog recovery and the complete Phase 6 integration.
Review was read-only and ran no tests, browsers or external operations. Evidence:
`.scrappy/phase6-red-final-review.log`. Phase 6 local acceptance is complete
(2026-10-16 Lima); the implementation is ready for separate release preparation
and an owner decision about promotion to main.

Local acceptance does not authorize
installation of staged migrations, enabling alternatives on real baskets,
connecting a production worker or delivery transport, real notifications, or
promotion/deployment. The optional local review hook remains opt-in and Vite does
not install it by default. Prepare/review the release separately; the owner
decides main and any operational activation. No Supabase test project is required
by SPEC 15, and its retired opt-in integrations are not reported as passed.

## Phase 6 module 1: SQL/API and migration design

Reviewed on 16 Oct 2026 against SPEC 11.1/14/15, basket migrations, API validators
and the alert consumer. This defines a design, not an installed migration or tested
SQL implementation. No production access, new service, variable or dependency.
Module 1 stays open until isolated local migration/RLS/conservation/rollback tests.

### SQL objects and invariants

Keep existing tables and IDs intact. Add `lists.purchase_mode` (`legacy` default,
`alternatives`); use existing `composition_version` as the sole configuration
generation. Proposed objects (not executable migrations):

| Table | Columns and constraints beyond the common keys |
| --- | --- |
| `purchase_configurations` | PK `(list_id,version)`; list FK; immutable `schema_version=2`, canonical configuration JSON, currency/budget with current constraints, `budget_enabled=true`, `winner_enabled=false`, `minimum_savings numeric(12,2) >= 0` default 0, created_at. |
| `purchase_needs` | name 1–100 characters, `required_quantity numeric(24,6)>0`, canonical unit, position >=0, `allow_surplus=false`, nullable unique-per-version `legacy_item_id`, created_at provenance. |
| `purchase_offers` | product FK `ON DELETE RESTRICT`, unique product per configuration, nullable positive integer `max_purchase_units`. One tracked presentation, never a manual price. |
| `purchase_coverages` | PK `(list_id,version,offer_id,need_id)`; positive numeric(24,6) quantity in the need's canonical unit per purchased presentation. |
| `purchase_extras` | offer FK, name, positive numeric(24,6) quantity, unit, `accepted=false`. Known additional articles are declared even when unaccepted; never cover a need. |
| `purchase_alternatives` | name, position; a fixed owner-declared nonempty purchase vector covering a nonempty scope. |
| `purchase_alternative_needs` | PK `(list_id,version,alternative_id,need_id)`; explicit scope. |
| `purchase_alternative_items` | PK `(list_id,version,alternative_id,offer_id)`; positive integer `purchase_units` <=2147483647. Repeated packs use this count. |
| `purchase_pins` | PK `(list_id,version,alternative_id)`; pins the whole scope. Multiple pins must have disjoint scopes and obey aggregate offer limits. |
| `purchase_reference_items` | PK `(list_id,version,alternative_id)`; optional explicit complete feasible reference selection. |
| `purchase_evaluations` | UUID PK, configuration FK, timestamp, input signature, engine version, immutable input/result JSON; unique `(list_id,version,input_signature,engine_version)`. |
| `purchase_alert_state` | PK `(list_id,version)`; last evaluation, budget latch/epoch, previous recommendation purchase signature, monotonic transition number. |
| `purchase_events` | UUID PK, configuration/evaluation FKs, transition number, frozen payload, reasons (budget/winner/both), claim status; unique `(list_id,version,transition_number)`. Existing notification mechanism owns event/channel receipts. |

Unless a composite PK is shown, configuration child PK is `(list_id,version,id)`
with UUID id. All child links use composite FKs to the same list/version; every
configuration child has a configuration FK. Only list deletion cascades, matching
current basket deletion semantics. Product deletion while referenced returns 409;
pause/repair instead. Removing an alternative never deletes its tracker. Restricting
product deletion after backfill is an intentional compatibility change to protect
historical configurations, and requires a readable API error in migration work.

Published configurations/children are immutable. Saving copies the full graph into
version +1, retaining unchanged logical IDs. SQL builds canonical JSON from rows;
it does not trust a caller's duplicate projection. History is not rewritten.
Canonical units: `ml`, `g`, `unit`; L/kg input multiplies by exactly 1000. No inferred
mass/volume/count conversion or substitution. Positive finite decimal strings only,
up to six fractional places after conversion; reject excess precision/exponents,
never silently round. `unit` quantities are integers. Legacy unit means one
purchased presentation: do not guess bottle volume or pack contents.
New JSON quantities, money, rates and bigint versions are decimal strings. Use
PostgreSQL numeric/Python Decimal, the existing SQL conversion multiplier (including
reciprocal PEN/USD) serialized losslessly, and existing aggregate-only two-place
rounding. No IEEE floating point in optimization or replay.

Every unit of an offer contributes all its declared coverage once; an alternative
cannot ignore covered needs outside its scope. Each scoped need must be satisfied;
excess requires surplus permission. Selectable alternatives cannot contain
unaccepted extras (unused draft offers may). A need with no alternative is allowed
and incomplete. Reject unknown fields, dangling/cross-version IDs, empty scopes or
vectors and incompatible units in the publishing SQL transaction.
No automatic synthesis of owner alternatives: compare one pack plus two bottles
by explicitly saving that vector. This finite comparison domain supports repetitions
within vectors; it does not search undeclared purchase recipes.

Selection is an exact partition of needs by disjoint alternative scopes, each used
at most once. A shared combo is one alternative covering multiple needs and is
charged once. Sum repeated uses of each offer across selected alternatives, enforce
the basket limit, then charge that count; never use the maximum of independent
uses. Overlapping combos cannot both be selected, even with surplus permission.
Canonicalize winners by aggregate `(offer_id,purchase_units)` vector, not labels.

### API and reproducible results

Legacy `/api/lists` and `/api/baskets/:id` retain existing shapes/numeric responses
in legacy mode. New `/api/baskets/:id/purchases` uses current session/origin/JSON
guards; browser-to-Supabase access remains forbidden.

| Method | Implemented contract and service-only RPC |
| --- | --- |
| GET | `{schema_version:2,list_id,mode,version,configuration,latest_evaluation,stale_reason,events,has_more}` via `read_purchase_configuration(uuid,integer)`. One MVCC snapshot; current evaluation is null when absent or obsolete. Configuration contains version, needs, offers/coverage/extras, alternatives/scope/items, pins, reference and notice settings. Legacy returns null configuration/evaluation and `stale_reason:"mode"`. |
| PUT | `{schema_version:2,expected_version:"…",configuration:{…}}` via `save_purchase_configuration(uuid,bigint,jsonb)`; full replacement, gate-first SERIALIZABLE transaction, CAS, validation, immutable insert, advance exactly once; returns `{schema_version:2,configuration:<committed canonical configuration>}`. Requires an already-alternatives basket; cannot activate legacy mode, send notices or create price checks. |

GET accepts only optional `page` (integer 0–10000, default 0); each page contains
at most 20 events, ordered by version/transition descending, with per-channel
delivery states and receipts. Historical event versions remain visible after
publication. Pagination uses offsets; concurrent new events may shift pages.
Versions and transitions are exact decimal strings, including values above the
JavaScript safe-integer limit. Responses use `Cache-Control: no-store`.
Only GET/PUT are exposed (POST returns 405). Evaluation remains an explicit local
adapter operation; no HTTP evaluation, activation or operational integration is
introduced. Invalid/missing session is 401, foreign/missing mutation origin is
403, and non-JSON PUT is 415. Storage errors never expose SQL details.

Local API acceptance (2026-10-16): `npx tsc`, the affected rewritten-product
regression, and `PURCHASE_API_LOCAL=1 node tests/purchase-persistence-sql.mjs`
passed. Six temporary-PostgreSQL groups cover migration up/down, service-only
permissions/RLS, canonical publication/read, invalid graphs/legacy/missing lists,
concurrent CAS, lost committed response reconciled by GET without write retry,
source/configuration/Lima-day freshness and bounded historical delivery pages.
The local HTTPS test exercises GET/PUT through the original handlers on HTTP/1.1
and HTTP/2 with fixture-only RPC responses, including session/origin rejection.
No live database, real channels, deployment or activation is part of acceptance.

Local UI acceptance (2026-10-16 Lima, SPEC 11.1/14/15): basket summaries and the
needs/offers/combo editor support explicit surplus/extras/limits, pins/reference,
canonical CAS publication and explicit reconciliation after an uncertain response.
The breakdown shows one charge per offer, product/store links, partial coverage,
exclusions and paginated channel receipts. The previously timed-out lists CRUD
test passed in isolation (1,075 ms versus Vitest's 5,000 ms limit); the original
slowdown is not reproducible and resource contention remains an unproven cause.
Its passing result completes the prior affected-test acceptance; after adding
product/store labels, all nine purchase UI tests and build/typecheck passed.
Manual React/contract review found no remaining blocking issue. Edge mobile
emulation at 320/390 px passed 18 visual checks for lists, results/coverage,
editor/offers/combos, partial results/exclusions and expanded receipts/pagination,
without horizontal overflow or JavaScript errors. Fixture-only evidence and
the reproducible script are in `.scrappy/purchase-visual/` and
`.scrappy/purchase-visual.mjs`; API traffic was GET-only. Operational wiring,
Phase 6 closure, activation and promotion remain pending.

Commit runs in a SERIALIZABLE transaction, takes list lock and rechecks generation
plus a freshly derived product/FX input signature. Serialization/deadlock conflicts
map to 409 without automatic engine-result retry; review/FX writers must participate
in the basket invalidation lock protocol before activation. No locks held across
engine execution; changed inputs return 409. Signature covers sorted configuration,
product/check state, FX and Lima validity date, not just the evaluation timestamp.
Same committed input returns its existing evaluation. Old-version PUT replay is
409; client GET reconciles lost responses. Statuses: 400/PT400 invalid config or
named resource limit, 401 session, 404/PT404 missing basket, 409/PT409 stale input
or incompatible legacy operation, 413 body >256 KiB, 503 storage unavailable.
No partial writes or automatic retry using a newer configuration.

Result envelope: `schema_version`, `configuration_version`, `engine_version`,
`input_signature`, `evaluated_at`, `currency`, independent `recommendation` (ignores
pins), `effective` (enforces pins) and `reference`. Each selection records:

- alternative IDs; aggregated purchases with offer/product IDs, integer counts,
  native price/currency, converted amount, price_check_id and last_success_at;
  FX multiplier/date/source/fetched_at; all product validity inputs, not only FKs.
- Required/covered/surplus quantities and units by need; extras; pending need IDs;
  exclusions with alternative/offer IDs and machine-readable reason.
- `coverage_complete`, `comparison_complete`, `search_complete`, `optimality`
  (`verified_minimum`, `verified_subset`, `unproven`, `infeasible`), `total`,
  `known_subtotal`, `estimated_subtotal`, visited nodes and limit reason.

No complete coverage (including invalid pin) means null total; expose a feasible
partial selection/subtotal and pending needs, not a synthetic complete total.
Estimated prices stay separate historical context. Any configured alternative
excluded by failed/unconfirmed/missing/unavailable price or invalid FX makes
comparison incomplete. Preserve current freshness/paused-price rules, failure from
first attempt and FX expiry after five Lima calendar days; add no invented product
age cutoff. Identical currencies require no FX; unsupported conversions are excluded.
An invalid pin is retained, never replaced; recommendation still runs independently.
Empty basket has null total and incomplete coverage. Truncated search is always
unproven; infeasible requires exhaustive search. Full search of valid options with
excluded alternatives yields verified_subset, never verified_minimum.
Historical evaluations preserve complete inputs/configuration, including excluded
prices/statuses, for replay; never expose recipes or secrets.

Explicit reference is valued on the same inputs for the same needs. Expose separate
`comparison_savings`/percent for recommendation/effective; invalid reference gives
nulls, zero denominator gives null percent, negative savings is permitted.
Keep existing aggregate product reference as `legacy_reference_total` and separate
savings fields; crossed-out product prices are not the comparison reference.

Budget requires effective coverage, complete comparison/search and valid pins;
use effective total and existing 3% hysteresis. Incomplete results neither trigger
nor rearm. Winner notices compare recommendation purchase signatures, revalue both
old/new vectors on current inputs and require positive savings >= configured
minimum; invalid previous selection cannot produce a savings notice. First result
or real configuration change establishes a winner baseline without a change notice.
Technical migration preserves the budget latch; real configuration changes reset
its baseline as today. Serialize transitions under list lock, claim before send,
combine both reasons into one event/channel delivery, preserve failed/ambiguous
receipts without resending ambiguous claims. Product failure/weekly/recovery alerts
remain product-owned. Legacy writer must skip alternatives mode before activation;
old pending claims cannot arm a new generation.

### Exact search and resource limits

`purchase-cover-v1` uses deterministic depth-first exact cover: choose the uncovered
need with fewest candidate alternatives, UUID tie order; enumerate alternatives by
UUID, reject overlapping scopes/offer limits, accumulate nonnegative decimal cost.
Prune only strictly more expensive accumulated cost than the incumbent, retaining
equal-cost choices. Pins preselect scopes; recommendation ignores pins. Equal
unrounded costs retain previous feasible purchase vector, otherwise lexicographic
aggregate `(offer_id,purchase_units)` order. Display rounding does not create ties.

Initial bounds: 32 needs, 64 offers, 128 alternatives, 32 items/scoped needs per
alternative, 32 extras per offer, six quantity decimal places, existing max-int
purchase counts. No silent candidate truncation. Each recommendation/effective
search gets 100000 expanded nodes (root included, checked before expansion) and
a 2-second monotonic deadline; reference feasibility is direct. These are engineering
bounds, not measured performance promises. Persist counts and interruption reason.
Node-limited replay is deterministic; deadline interruption need not be.
On exhaustion return best feasible incumbent as unproven, or null total/pending
needs if none. Never claim infeasibility/optimality or emit aggregate events after
interruption. Validate limits, exact boundaries and local timings before enabling.

### Local versioned snapshots (module 2)

`lib/server/purchase-snapshots.ts` archives the complete engine input projection,
including excluded offers, checks, exact decimal strings, FX, pins, references and
previous tie choices. Snapshot format 1 wraps schema 2 and `purchase-cover-v1`;
basket/configuration versions remain independent. The archive is detached from its
caller and deeply frozen; existing output files are never overwritten.

Create a local JSON request with exactly `list_id` and `inputs` (`PurchaseInput`
from `lib/server/purchase-engine.ts`, not a SQL row or a live API response). Then:

```powershell
npx tsc
node .scrappy/api-build/scripts/purchase-replay.js capture .scrappy/purchase-input.json .scrappy/purchase-v1.json
node .scrappy/api-build/scripts/purchase-replay.js replay .scrappy/purchase-v1.json
node --test .scrappy/api-build/tests/purchase-snapshots.test.js
```

The SHA-256 input signature covers canonical collection order, basket/version,
engine, search limits, all input state and the Lima validity date; capture timestamp
alone does not change it. A separate checksum covers the entire archive, including
timestamp/result and recorded monotonic clock samples. Replay uses those samples
to reproduce even deadline interruptions exactly, checks the complete result and
rejects incompatible versions or altered archives. Checksums detect corruption,
not authorship. Unrecorded real-time evaluations can still stop at different nodes.
JSON input rejects unknown fields and invalid scalar types; no recipes or secret
fields are accepted. Keep local archives in ignored `.scrappy/`.

This does not install an evaluation writer, SQL capture/commit RPC, current-version
selector, operational recalculation, events or API/UI. The shadow tables and legacy
operation are untouched. Live concurrency/idempotency and activation remain module 3
work; module 2 replay is verified entirely with local fixtures and a fresh process.

### Module 3 design: coherent capture, conditional commit and invalidation

Contract designed 16 Oct 2026 (SPEC 14/15). An inactive implementation is prepared
in `lib/server/purchase-persistence.ts` and additive migration
`20261016010000_purchase_persistence.sql`, with a guarded local rollback. It has
no operational callers, triggers on sources, activation, API or notification wiring.
`npx tsc` and six adapter/token unit tests passed previously and were not repeated.
The isolated runner `node tests/purchase-persistence-sql.mjs` now passes all 14
protocol acceptance groups: idempotency/immutability, stale-state CAS, product
changes/ABA, dependency discovery, FX, Lima date expiry, configuration isolation,
atomic failed commits, mixed projections/deletion, RLS/service isolation, both
capture/review orders, two identical workers, membership publication before
product/FX writes, and missing-gate/guarded rollback. Independent connections and
observed lock barriers verify SERIALIZABLE aborts; no timing sleeps are used.
The successful temporary cluster was stopped and removed. Earlier runner defects
(CRLF framing, parallel admin reads, stale fixture versions and non-JSON booleans)
are corrected; protocol parse errors now reject promises and reach `finally`.
One earlier stopped fixture directory `.scrappy/purchase-persistence-pg-JyzqsW`
remains ignored because automatic policy review rejected recursive deletion;
its database shutdown was verified. Acceptance is local to the inactive protocol,
not module-3 closure or deployment readiness. Source publication uses the gated adapter
boundary; full configuration publishing and operational writer participation remain
separate integration work before activation.
The following refines the proposed RPCs
above; no implementation has been installed outside a disposable local database.
`capturePurchaseSnapshot` remains an offline engine archive, not a database capture.
Implement this contract in a new additive migration, leaving the tested shadow
migration unchanged. Keep legacy operation authoritative until a separate release.

#### Operational writer inventory (local integration, 2026-10-16)

`20261016020000_purchase_writers.sql` prepares gate-first service RPCs without
switching any basket mode or starting workers. Existing RPC names, arguments,
defaults and return types are retained. Their old bodies live in the unexposed
`purchase_writer_internal` schema; service/anon/authenticated have no schema access.
Each public wrapper enters the gate before invoking any old body or reading source
state. PostgREST starts these RPC transactions at SERIALIZABLE using their
`default_transaction_isolation` setting ([documented contract](https://postgrest.org/en/stable/references/transactions.html#isolation-level));
direct SQL callers must explicitly start SERIALIZABLE transactions. The gate
checks the actual isolation level and fails closed. There is no automatic retry.

| Entry point / caller | Locks reached after the gate | Purchase effect |
| --- | --- | --- |
| `save_review` / Python | Product, checks, legacy snapshot/list | One invalidation after checks and product state, including failures and unchanged prices. |
| `create_product_reading`, `claim_product_reading`, `complete_product_reading` / API/Python | Reading row | Queue state only; no input invalidation. |
| `create_product_repair` / API | Reading, product | Baseline only; no invalidation. |
| `confirm_product_reading` / API | Reading, product, membership/list, recipe | One invalidation after a new confirmation/repair; confirmed replay does not invalidate. Legacy insertion into alternatives membership rejects with 409. |
| `mutate_product` / product API | Product and dependent FK/cascade/list rows | Edit/pause/resume/reference invalidate all current offer dependencies once. Retained offers reject deletion atomically; unreferenced deletion preserves legacy cascade behavior. |
| `cache_exchange_rate` / Python | FX unique row, legacy lists/snapshots | One invalidation for all current cross-currency offer dependencies, including excluded offers. Successful unchanged upserts may conservatively invalidate. |
| `mutate_list` / lists API | Lists table, list/cascade rows | Existing create/rename/order/delete behavior; no new configuration publication. |
| `configure_list_basket`, `set_basket_item` / basket API | List, product FK, membership/snapshot | Legacy only; alternatives mutations reject with 409 before legacy work. |
| `record_basket_snapshot` / nested legacy writers | List/snapshot | Skips alternatives mode. Product reference changes and FX triggers also skip alternatives lists, preserving their version. |
| `claim_basket_events` / Python | Legacy list, event | Claims only legacy baskets. |
| `finish_basket_event` / Python | List then event | Records existing receipt, but cannot arm alternatives mode. |
| `save_product_alert_state` / Python | Product | Preserves review/prior-alert CAS; empty result on stale state. No purchase input change. |
| `record_notification` / Python/settings API | Notification and product FK | Audit receipt only, outside channel delivery; no purchase input change. |
| Capture/commit/current evaluation RPCs | Gate/list/runtime/evaluation | Existing persistence protocol. No recalculation or delivery is added. |

Service-role direct INSERT/UPDATE/DELETE/TRUNCATE on products, checks, readings,
lists, memberships, FX, legacy events/snapshots and notifications is revoked;
their reads remain available. Shadow configuration/state tables already deny
service writes. Trigger helper execution is not a bypass. API product edits and
deletes, Python individual alert CAS and Python/settings audit inserts now call
the protected RPCs. Serialization/deadlock errors map to API 409; Python propagates
failure without retrying a scrape or delivery. HTTP, scraping, engine computation
and channel delivery happen outside these short database transactions.

Independent settings, run logs, login/IP locks and recipe learning do not acquire
product/list/runtime locks and remain outside the gate. Recipe learning can
contend on a domain row with confirmation, but never waits for the gate afterwards.
Full alternatives configuration publishing and purchase notice/state writers are
still absent: they must use this boundary before future activation. No real
activation or deployment is authorized by these changes.

Local writer acceptance uses `PURCHASE_WRITERS_LOCAL=1 node tests/purchase-persistence-sql.mjs`
after TypeScript compilation; it never loads `.env`. `PURCHASE_WRITERS_FROM` resumes
at a numbered writer group without rerunning accepted groups. Assertions cover
actual legacy RPC bodies, direct/private bypass denial, stale-review rollback,
repair replay, CAS receipts, FX, mixed-mode claims, gate lock barriers for every
entry point, reverse review/capture order, missing gate, FK rejection and down.
The guarded writers down must run before persistence/shadow down, with all writers
excluded; it restores stored legacy definitions and pre-migration service grants.
This validates local PostgreSQL and the RPC isolation metadata; deployed
PostgREST/Supabase behavior remains a separate release check.

Local writer acceptance is **complete** (2026-10-16 Lima): the ten writer SQL
groups passed across resumed runs, retaining the previously accepted TypeScript
compilation, 46 affected API tests, ten Python alert tests and first three SQL
groups without repeating them. The legacy-membership fixture now enters the gate
in SERIALIZABLE before inserting. Groups 4–7 passed repair/replay, FX, mixed-mode
claims, CAS/receipts and gate barriers for all 17 entries. The reverse review/capture
fixture initially rejected a fixed timestamp older than repair's database time;
it now advances the persisted timestamp by one second in SQL, preserving precision.
Resuming at group 8 passed review/capture serialization, FK/missing-gate rollback
and protected down, including exact legacy function definitions and service grants.
Both temporary clusters from this continuation were stopped/removed. Integration
review and diff-check found no blocking issue. Full configuration publishing,
recalculation and purchase notices remain separate work; module 3 and release
are not complete. No deployment, mode activation outside fixtures, production
access or commit occurred.

#### Atomic configuration publication (local, staged)

`20261016030000_purchase_publication.sql` adds the service-only
`save_purchase_configuration(uuid,bigint,jsonb)` RPC and the exclusive-connection
`savePurchaseConfiguration` adapter. It enters the SERIALIZABLE gate before any
source/list read, locks the list and compares its exact expected version. It
requires **already-enabled alternatives mode**; legacy calls return PT409. Neither
the migration nor adapter activates a basket or installs an HTTP route/worker.

The replacement input has exactly `schema_version`, `currency`, `budget`,
`budget_enabled`, `winner_enabled`, `minimum_savings`, `needs`, `offers`,
`alternatives`, `pins`, `reference`. Child fields follow the graph above;
needs accept `id,name,required_quantity,unit,position,allow_surplus`. Versions and
need provenance (`created_at`, `legacy_item_id`) are server-owned output fields,
not replacement input. Unchanged need IDs retain provenance. Decimal amounts are
strings; positions, purchase counts and optional maximum counts are JSON integers.
Need/extra L and kg normalize exactly to ml/g; offer coverage quantities already
use the referenced need's canonical unit. Reject rounding, unknown fields,
dangling/duplicate IDs, invalid scopes/vectors, unaccepted selectable extras,
unauthorized surplus and incompatible pins/reference. Empty/incomplete drafts are
allowed. Limits are 32 needs, 64 offers, 128 alternatives and 256 KiB JSON.

Each successful save, including an identical replacement, builds one new immutable
generation and canonical JSON from typed rows. In the same transaction it advances
composition once, invalidates the runtime pointer, advances input/state revisions,
clears tie vectors and initializes the new notice baseline. No evaluation, price,
snapshot, event or notification is emitted. Old captures and PUT replay fail with
409; there is no automatic retry or overwrite. Historical graphs remain intact.
The reverse migration takes the gate first and refuses any recorded publication,
including after list deletion or a manual mode reset; unused installation reverses
without changing existing data/definitions/grants.

Local acceptance (2026-10-16 Lima): TypeScript compilation, the new adapter unit
test and ten PostgreSQL publication groups passed. Run the affected SQL suite with
`$env:PURCHASE_PUBLICATION_LOCAL='1'; node tests/purchase-persistence-sql.mjs`
after `npx tsc`; no `.env` or external database is read. Cases cover full canonical
graphs, settings/identical saves, 25 invalid-graph rollback cases, drafts/extras,
permissions/isolation/missing gate, two publishers, publication/evaluation commits
in both orders, product/FX dependencies in both orders and protected down. Both
temporary clusters were stopped/removed; the first installation attempt had a
corrected CASE-expression syntax error. Manual integration review and diff-check
found no blocking issue. Recalculation/notices, API/UI and activation remain
separate; module 3 and promotion are not ready. No production/main/deployment.

#### Local alternatives recalculation (accepted, inactive)

`recalculatePendingPurchases` in `lib/server/purchase-recalculation.ts` composes
pending discovery, gated capture, the existing pure engine and validated atomic
commit. It is an explicit server-side local entry point with an exclusive
`PurchaseConnection`; no API, scraper, timer, Actions or startup invokes it.
No new migration, dependency, activation path or channel delivery is added.

The durable pending predicate is the existing current-evaluation validity check:
dirty, missing or stale revisions/configuration/Lima date. Multiple invalidations
coalesce into one calculation using the latest captured sources. Advisory
discovery is rechecked under the SERIALIZABLE gate before reading inputs, skipping
deleted, legacy or already completed baskets. Engine work runs outside locks.
CAS/serialization conflicts and outages produce a per-basket `deferred` outcome
without clearing work or retrying a result. A fresh explicit pass captures again;
after a lost successful commit response it finds the valid current evaluation and
creates no duplicate history. An incomplete but current result waits for an input
change or expiry, rather than spinning. New notices/baselines remain separate.

Each call processes at most `limit` candidates (default 25, allowed 1–100), once
each. Follow `nextAfterListId` through `{afterListId, limit}` until it is null,
then restart from the beginning on the next sweep. This lets later baskets progress
past repeatedly failing ones; deferred earlier IDs wait for that next sweep.
Discovery failure rejects the call; per-basket failures do not stop later entries.
An empty pass is inert. Reports contain disposition/status, never raw SQL errors.

Local acceptance (2026-10-16 Lima): `npx tsc`, four new unit tests and ten
PostgreSQL temporary-cluster groups passed on the first run. Run only this SQL
scope with `$env:PURCHASE_RECALCULATION_LOCAL='1'; node tests/purchase-persistence-sql.mjs`
after compilation; it reads no `.env`. Cases cover paginated draining/legacy
exclusion, coalescence, product/publication conflicts, real product-review failure
and pinned recovery, two workers, stale discovery, disconnect after capture,
lost commit response and Lima midnight. No scraping, event or receipt is produced
by recalculation. The cluster was stopped and removed; manual integration review
found no blocking issue. Module 3 notices, API/UI, activation and release remain
pending, without production/main/deployment or a commit of the existing worktree.

#### Local review/recalculation integration (accepted, inactive by default)

`localReadings(root, { afterProductReview })` can explicitly connect product-child
completion to `localPurchaseReviews(connect, limit)`. Pass the returned object's
`afterProductReview` callback to the executor. Reading/confirmation children do not
invoke it. A nonzero product exit still invokes it because a review may already
be durable. Callback rejection is reported without changing the saved review;
recalculation remains pending in SQL. Vite installs no callback by default and no
production runner, scheduler, activation path or channel transport is connected.

The local hook drains one UUID-cursor sweep on a fresh exclusive connection supplied
by the caller and always closes it. Overlapping completions share a promise and
request one further sweep for changes to earlier UUIDs. Deferred results are not
immediately retried. `recover()` explicitly starts a fresh authoritative sweep,
including after process restart or a missed completion; it does not scrape, resend
or trust an in-memory queue. No new database driver or credentials are introduced.

Acceptance (2026-10-16 Lima): TypeScript compilation, six affected unit/executor
tests and three temporary PostgreSQL integration groups passed. The offline child
uses the real Python `execute_reviews`, parser, validator and `save_review` RPC;
FX/provider and notification callbacks are replaced with fixtures. Cases cover
paginated draining, deduplicated child execution, pinned failure/recovery, a child
stopped after saving, callback outage and recovery with a new hook. Price-check
counts prove one review per child and no rescraping during recovery; notification,
delivery and legacy-snapshot counts remain unchanged. The first SQL run found a
fixture clock earlier than its review; aligning that clock resolved `future_price`.
Both temporary clusters were stopped and removed. Reproduce without `.env`:

```powershell
npx tsc
node --test .scrappy/api-build/tests/local-purchase-reviews.test.js .scrappy/api-build/tests/local-readings.test.js
$env:PURCHASE_LOCAL_REVIEWS='1'; node tests/purchase-persistence-sql.mjs
Remove-Item Env:PURCHASE_LOCAL_REVIEWS
```

Real operational wiring, activation, Phase 6 final review and release remain pending.

#### Local alternatives notices (accepted, inactive)

Migration `20261016040000_purchase_notices.sql` adds an evaluation-insert trigger
inside the validated SERIALIZABLE commit. Budget uses the effective rounded total,
complete coverage/comparison/search, valid pins and the strict >3% rearm boundary.
Winner compares canonical purchase vectors, revalues the previous recommendation
with this evaluation's valid prices/FX, and requires positive exact savings >= the
configured minimum. The first verified recommendation per configuration version
establishes its baseline; every subsequent verified recommendation advances it,
including changes below the threshold. An excluded previous alternative produces
no invented savings. Recommendation remains independent of the effective pins.
Simultaneous budget/winner reasons create one frozen event with two channel slots.

`purchase_deliveries` is the authoritative alternatives receipt store, separate
from legacy/product `notifications`: one row per event/channel, protected by RLS,
no service DML, and service-only claim/finish RPCs. Pending slots become claimed
in a committed transaction before any sender invocation. Final statuses are sent,
failed or ambiguous; a disconnected/missing receipt retains claimed. No status
can be automatically reclaimed, including definite failures. Event status is a
coarse aggregate (sent if any channel confirms, failed if both finish without a
confirmed send, claimed while any slot is unfinished); inspect channel receipts
to distinguish ambiguity from definite rejection. Late receipts never mutate the
budget latch, winner baseline or a newer version. Down refuses any evaluation
processed by this migration, even after basket deletion, through a private ledger.

`deliverPurchaseNoticeLocally` requires an exclusive database connection and two
explicit injected callbacks; there are no default/live transports or environment
reads. A callback must return failed only for a definite rejection; throws and
unknown results are ambiguous. Each channel progresses independently; uncertain
claim acknowledgements prevent sending, and uncertain finish acknowledgements
never permit replay. Spanish messages preserve both reasons and basket/offer link
data. The basket path is a staged contract for the future alternatives API/UI;
no current deep-link navigation or deployed delivery is claimed as accepted.

Local acceptance (2026-10-16 Lima): `npx tsc`, three unit tests and twelve temporary
PostgreSQL groups passed. Compile, then run
`$env:PURCHASE_NOTICES_LOCAL='1'; node tests/purchase-persistence-sql.mjs` without
`.env`. Coverage includes equality/hysteresis, partial comparison and pinned
recovery, below/exact threshold, current-price revaluation, invalid previous
winner, version reset, concurrent commits/senders, combined reasons, both-channel
failure, ambiguous delivery, lost claim/receipt acknowledgement, replay, RLS and
protected rollback. The first SQL attempt exposed a fixture using a sub-cent
boundary after monetary rounding; the corrected cent-exact boundary passed on the
second run. Both clusters were stopped/removed. Manual integration review found
no blocking issue. Prior recalculation acceptance above remains historical for
the migration set without this trigger; with this migration, explicit commits
also create local notice state/events. No API/scraper/cron hook, activation, real
send, production/main change or deployment was added. Module 3 operational wiring,
alternatives API/UI and release remain separate work.

#### Persistence and identity

Proposed service-only objects, with RLS and revoked PUBLIC/anon/authenticated access:

| Object | Required contract |
| --- | --- |
| `purchase_operation_gate` | Exactly one pre-created row with an increasing bigint `fence`. Every participating capture, commit and input/state mutation updates this row first in its transaction. It is a serialization fence, never an input signature or a queue. |
| `purchase_runtime` | PK/list FK `list_id`; `configuration_version`, monotonic `input_revision` and `state_revision`, `dirty`, nullable `current_evaluation_id`, retained recommendation/effective tie vectors. Composite FKs keep the configuration and current evaluation in this list/version; list deletion cascades. Revisions never reset on a configuration change. |
| `purchase_evaluations` extension | Store the exact format-1 archive, capture token, persistence signature and resulting `committed_state_revision`, without changing the archive's checksum/signature semantics. Reuse the existing `inputs`/`result` projections but check agreement with the archive. Historical rows remain immutable. |

The capture token is a versioned JSON envelope with `list_id`, `configuration_version`,
`input_revision`, `state_revision`, `mode`, database `evaluated_at`, `validity_date`
(America/Lima), canonical source fingerprint, supported engine/search limits, and
`capture_signature`. Versions/revisions are decimal strings. The signature hashes
all other token fields using `canonicalJson`/SHA-256; it detects mismatch, not
authorship. The source fingerprint covers canonical configuration/notice settings,
all referenced products (including excluded offers), selected/latest checks and
validity/failure/availability/confirmation state, reference prices, canonical FX
row or explicit absence. The token separately records previous tie vectors from
committed state; these are protected by state revision, not the source fingerprint,
so an identical retry can still verify source freshness after its own commit.
Exclude recipes, credentials and unrelated tracking metadata.

Keep two identities explicit: the archive `input_signature` is the existing engine
projection hash; the SQL `purchase_evaluations.input_signature` becomes a persistence
signature over capture signature plus archive input signature and engine version.
Keep its existing unique constraint. Distinct invalidation revisions, including
A→B→A, can create distinct historical evaluations even if the engine inputs match.
A retry of one capture has one identity. The runtime pointer, never MAX(timestamp),
selects the current evaluation; old rows remain history, not fallback current data.

#### Transaction and lock protocol

Use SERIALIZABLE for capture, commit and participating mutations. Their first data
operation is `UPDATE purchase_operation_gate SET fence = fence + 1 ... RETURNING`;
require exactly one row or fail closed. This write matters: a transaction whose
snapshot predates a competing gate update must abort with 40001, rather than read
an old snapshot after waiting for a lock. No preliminary configuration/product read
or lock in that transaction. Then lock lists/runtime in UUID order, followed by
product/reading, alert-state and event rows in a consistent order. All entry points
must acquire the gate before any existing row locks, including repair confirmation.

A single short global gate is deliberately sufficient for this single-user app;
it also protects membership discovery and a missing/new FX row without predicate
lock gaps. It serializes database work only: never scraping, engine execution,
HTTP/channel delivery or user interaction. Do not substitute a late trigger that
acquires the gate after a product lock. Before activation, inventory and wrap all
review, repair, pause/resume, configuration/membership, product delete, FX upsert,
alert-state/receipt and legacy entry points that can overlap these locks. Legacy
claims must skip alternatives mode. A partially participating writer set is unsafe.
Production writers are not modified by this design task.

40001/40P01 map to 409 with the transaction fully rolled back, including fence
changes; lock timeout/storage outage returns 503. No automatic result retry or
hidden unbounded loop. A caller may start a fresh capture/evaluation after 409.

#### RPC sequence and observable outcomes

1. `capture_purchase_inputs(list_id, expected_version)` takes the gate and list,
   verifies existence, alternatives mode and version, then derives the complete
   `PurchaseInput` plus token from that transaction's coherent source state. Take
   `clock_timestamp()` after acquiring the gate, not transaction-start `now()`.
   Configuration may be incomplete but must be structurally valid. Copy prior
   feasible recommendation/effective tie vectors from committed state; retain the
   last valid vectors when an incomplete result has none. Capture does not move
   runtime pointers, clear dirty state, establish notice baselines or create events.
   Commit this short transaction and run the unchanged pure engine outside locks.
2. `commit_purchase_evaluation(list_id, expected_version, capture_signature,
   payload)` receives exactly `{capture, snapshot}` from a trusted server worker,
   never a browser-supplied result. Validate supported versions, strict fields,
   capture hash, exact replay/checksum and agreement of basket/version/time/limits
   before opening the short persistence transaction. The trusted adapter must also
   verify that archive inputs exactly match the captured source projection and tie
   vectors, rather than accepting an unrelated replayable result. Checksums are not proof that
   the worker is trusted; API session/service-role boundaries remain mandatory.
3. Under gate/list lock, require current mode, configuration and input revision,
   freshly derived source fingerprint and Lima date to match the capture. Do not
   replace `evaluatedAt` in the archive. If midnight has passed, reject 409 even
   for a same-currency basket; fresh capture handles FX's five-day boundary. Compare
   `state_revision` too, since a prior commit can change tie choices and baselines
   without changing prices. Source comparison includes absent/excluded inputs,
   not merely the winning offers. Any mismatch writes no evaluation/state/event.
4. Exception for idempotent retry: after input/mode/version/day checks, if this
   persistence identity already exists AND is the runtime current evaluation,
   return that stored archive with `disposition:"existing"`, without replaying
   state transitions. Ignore the state-revision increment caused by that very
   commit, but require the supplied capture/archive to equal the stored payload.
   Otherwise a state mismatch is 409. Same identity with different payload is
   409 `evaluation_conflict`, including different deadline-cut results; first
   accepted result wins, never overwrite it.
5. For a new accepted capture, insert immutable evaluation, set current pointer,
   clear dirty, increment state revision exactly once and update retained tie
   vectors atomically. Return `{disposition:"inserted",evaluation_id,capture,snapshot}`.
   Incomplete/unproven results may be current and clear dirty: they describe the
   current inputs, not permission to send or a request for endless retries.
   Future budget/winner state changes and combined event claims belong in this
   same transaction; later channel receipts refer to the frozen event/version and
   cannot arm a newer generation. This task does not implement or claim acceptance
   of the notice machine, delivery retries or channel ambiguity handling.

Return 400 for malformed payload, 404 for deleted/missing basket, 409 for obsolete
mode/version/input/state/day or identity conflict, and existing API 401/413/503
guards. After a lost response retry the identical capture/archive; after a conflict
GET and recapture explicitly. A second worker must return the stored result or
409, never claim a second transition from the same captured state.

#### Atomic invalidation and local recalculation boundary

An accepted review (including failure, suspicious price, unavailable or unchanged
price with a new check), repair/confirmation or relevant product change updates
its product/check rows and all affected *current* alternatives-mode runtime rows
in one gated transaction. Discover dependencies through all current-version
`purchase_offers`, not only winners, pins or legacy memberships. Deduplicate list
IDs, increment each input revision once per source transaction, set dirty and
clear its current pointer; preserve evaluations, notice baselines/latches and
individual alert semantics. Rejected optimistic writes/rollbacks invalidate nothing.
Shared products affect every dependent basket; standalone products affect none.

FX insertion/update/removal invalidates current alternatives baskets with any
foreign-currency offer, including currently excluded ones and a previously absent
rate; conservative invalidation on an unchanged successful upsert is allowed.
Configuration save copies the immutable graph, advances composition once, updates
runtime version, increments input AND state revisions, clears the current pointer
and marks dirty in the same transaction. New-version notice baselines follow the
module-1 rules; old evaluation/event receipts remain historical. Removing an offer
is a configuration change, not product deletion.

Time passage needs no scheduler write: the current-selector is one coherent SQL
read joining runtime/configuration/evaluation and requiring matching input revision
and evaluation `committed_state_revision` (the capture state revision plus one),
mode, version, clean state and today's Lima date. A mismatch returns null current
evaluation with a stale reason, keeping history available. The next local explicit
evaluation or existing scheduled processing pass captures again. Dirty rows are
durable coalesced work; workers may capture the same revision and use commit CAS.
After source commit, scan dirty/current-date-stale rows and recalculate without
another URL scrape. A later invalidation cannot be cleared by an older worker.
No new scheduler, polling loop, external service or activation is introduced here.

#### Local acceptance cases and integration boundaries

The 14 groups above execute the capture/commit/invalidation protocol; notice and
receipt behavior in the matrix remains a later integration requirement.
Use temporary PostgreSQL on Windows, the existing shadow fixtures and at least two
independent connections with explicit barriers, never timing sleeps. Disconnect
all external clients; no .env, Supabase, Actions, browser or real channel calls.
Assert rows, revisions, immutable archives and transaction outcomes, not just HTTP
codes. Pure tests cover token canonicalization and archive/persistence identities.

| Case / controlled interleaving | Required observation |
| --- | --- |
| Capture holds gate; review attempts entry; then reverse their order | Capture is wholly before or after review; waiting obsolete SERIALIZABLE snapshot aborts, never mixes product/check state. |
| Capture A; config/pin/reference/budget/mode save B; commit A | 409; no evaluation, pointer, baseline or event write from A; B stays dirty. Versioned history is retained. |
| Capture A; review failure/suspect/unavailable/recovery, same-price new check, or repair B; commit A | Each mutation invalidates A, including an offer excluded from the winner. No synthetic price or duplicated individual failure alert. |
| Capture A; price A→B→A; commit A | 409 on revision despite equal final values; a new capture has a different persistence identity. |
| Shared tracker, standalone tracker, old-version-only reference | All and only current dependent alternatives baskets invalidate once; legacy results remain unchanged. |
| Capture A; previously missing FX inserted, FX replaced/deleted; commit A | 409 for dependent baskets; unchanged native-currency baskets remain current. |
| Capture before Lima midnight / FX age five→six days; commit/read after | Commit 409 and selector null without any source write; fresh result excludes expired FX and cannot trigger/rearm budget. |
| Two identical captured workers; first commits, second commits/retries after lost response | Exactly one evaluation/pointer advance/state increment; second returns stored archive, no duplicate future event. |
| Two captures with same prices but different times; commit later capture first | Earlier state's commit is 409; timestamp order alone never replaces current state. |
| Same capture, different valid deadline traces/results | First accepted archive is immutable; second gets evaluation_conflict even when both replay correctly. |
| Invalidate while worker evaluates, then resume; crash before commit or inject failure after insert | Dirty state survives; failed transaction leaves no partial evaluation/pointer/state/event and retry starts from persisted state. |
| Product/config/FX concurrent writes and membership addition/removal | Gate-first entry prevents missing a newly dependent basket and lock inversion; serialization/deadlock errors map to 409 with no partial changes. |
| Basket deletion or concurrent old-version receipt | Commit returns 404/409; no resurrection; receipt cannot change new-version state. |
| Partial/invalid pin/node or deadline limit, empty basket | Result can be current and replayable; no aggregate trigger/rearm, silent pin replacement or automatic scrape/retry loop. |
| Forged/mixed token, altered archive, wrong list/version, unsupported fields/versions, anon/authenticated access | Reject before persistence; no cross-basket writes, secrets or client table/RPC access. |

Implementation order: first token/adapter unit tests and additive gated SQL
capture/commit/invalidation with the local races above; then, separately, wire
operational recalculation and implement notice transitions/channel receipts with
their own SPEC 15 boundaries (threshold, first baseline, current-price revaluation,
budget hysteresis, combined reasons, partial delivery and ambiguous no-resend).
No module-3 closure or readiness for main is asserted by this design.

### Migration, compatibility and local acceptance

1. Add a transactional migration after the eleven existing files; do not replay
   them. Lock legacy list/membership input consistently. All new tables enable RLS;
   revoke PUBLIC/anon/authenticated table and function access, grant required
   service_role access only. RPCs use SECURITY INVOKER and empty search_path.
   Service-role bypass means API authentication is essential; no client policies.
2. Backfill each list at its existing composition version in legacy mode. Preserve
   basket item ID as need/legacy_item_id, quantity/order/created_at; reuse item UUID
   in the separate offer/alternative tables for deterministic identity. One offer
   references the same product and covers one presentation unit; sole alternative
   buys the old quantity. Preserve all products, checks, references/prices and old
   snapshots/events/latches/epochs byte for byte; no version bump, snapshot/claim
   call, synthetic observation or event. Standalone products stay standalone.
3. Legacy remains authoritative during module 1; backfill is a shadow, not dual
   live authority. Refresh shadow from then-current legacy version/rows under lock
   before eventual activation. No engine/v2 editing/event writer exposed yet.
   Large legacy baskets/quantities remain usable; new limits block only activation.
4. Activate later only with engine/API/web/consumer ready together. First real edit
   creates version +1 and switches mode atomically. Legacy membership/quantity,
   list-budget and reading-confirmation writers reject affected mutations with 409
   or delegate to the v2 transaction. Product/FX legacy snapshot triggers skip v2
   and schedule v2 evaluation instead. Runner membership and product repair/deletion
   must account for offer links. Never sum every alternative product. Old basket
   reads/writes return explicit 409 in v2 mode; updated UI/list catalog handles
   mixed modes and uses v2 summaries. This is a future compatibility gate.
5. Before activation, local down migration drops only additive objects/column in
   reverse dependency order and restores modified definitions/grants. Legacy rows
   remain intact. After v2 editing, retain v2 history/reads and disable writes for
   recovery; never flatten combos or discard history to return to legacy. Fixture
   restoration proves local rollback, not permission for a production restore.

Manual review traced requirements to the following future tests; none of these
SQL/engine tests is claimed executed by this design task:

| Case | Expected evidence |
| --- | --- |
| Conservation | Multi-basket/standalone IDs, order, quantities, references, prices, checks, snapshots/events/latches identical; legacy summary equal at fixed timestamp; empty/incomplete/FX/max-int fixtures; no new event. |
| Prices and combinations | Pack 12 vs four singles 11.20; litre 3 vs two half-litres 2.60; combo 5 vs separate 5.30 charged once; overlap rejected; repeated packs, limits and summed shared-offer uses. |
| Coverage | 1.5 L requires surplus; juice extra requires acceptance; incompatible units, undeclared equivalence and fractional counts rejected. |
| Failures/pins/reference | Two valid plus one failed: verified_subset and no budget event; invalid pin persists; invalid reference nulls; individual failure/weekly/recovery unchanged. |
| Search | Small exhaustive oracle, global-vs-line minimum, stable ties, exact decimal FX/aggregate rounding, empty/no solution, exact node boundary/deadline and oversized configurations without false optimality. |
| Concurrency/security/down | Competing saves and changed check/FX inputs return 409; cross-list FKs reject; PUBLIC/anon/authenticated cannot read/write/execute; service-role API only; whole failed migration rolls back; local up/down conserves legacy data. |
| Events in later module | Baseline/config changes, exact threshold, invalid old winner, hysteresis, concurrent claim, combined reasons and ambiguous/failed channels; no per-membership product alerts. |

Design review found no unresolved schema/API blocker within the explicit finite
comparison domain. Executable migration and its local tests remain pending;
this does not close Phase 6 or authorize a release.


### Stage-5 release candidate (2026-10-17 Lima)

Candidate code: `cf320a75a0c1a71197b64797b3ed3e8564a0cef0` on `develop`,
based on `1d2e5c0`. Documentation commit
`88fa7e3e96c3794cbcf967dbb5fa0923b6aa60af` completes the candidate. The review
range is `1d2e5c0..88fa7e3`; later review documentation does not change its identity.

| Commit | Review scope |
| --- | --- |
| `692bbc2` | Bounded recovery worker, shared notice/recalculation helpers and worker fixtures. |
| `97353dc` | Explicit PostgreSQL/notification adapters, local composition, dependencies and environment template. |
| `c97d9f1` | Atomic activation migration/guarded rollback, authenticated API, confirmation UI and fixtures. |
| `cf320a7` | Disabled-by-default Actions integration, workflow ordering tests and shared SQL fixture entry point. |

The SQL fixture entry point in the last code commit connects all three fixture
modules; review and use the complete candidate for SQL acceptance. Recorded
stage-1 through stage-4 Windows/local evidence above remains applicable: no
functional edits were made during packaging and unchanged suites were not rerun.
Final packaging checks cover whitespace, tracked-file scope, commit grouping and
manual review of worker, adapters, activation and workflow boundaries. Manual
review found no blocking issue; no automated `/review` was available in this chat.

This is a local release candidate, not a deployed or operational acceptance.
No push, main promotion, migration application, live connection, notification,
worker enablement or basket conversion was performed. `PURCHASE_WORKER_ENABLED`
remains false/unset by default. The owner must separately authorize publication,
main promotion, deployment and any enablement/conversion. Real SQL login/TLS/pool
compatibility, deployed migration/API readiness, timing/free usage and ordinary
run reconciliation remain deployment checks; offline acceptance does not prove
them. Preserve the Healthchecks 3h/9h and sole ordinary scheduler configuration.

### Candidate review recommendation (2026-10-17 Lima, SPEC 14/15)

Recommendation: accept `88fa7e3e96c3794cbcf967dbb5fa0923b6aa60af` as the
locally accepted candidate for the owner's release decision. Manual review of
the complete `1d2e5c0..88fa7e3` range (five commits, 30 files) found no blocking
findings. This recommendation is not authorization to publish, promote, deploy
or activate it.

Review covered the bounded worker's independent recalculation/delivery sweeps,
durable claim-before-send and ambiguous receipt handling, exclusive PostgreSQL
sessions and verified TLS/role restrictions, historical notification context,
atomic activation with source fingerprint/version checks and durable replay
receipts, guarded rollback, authenticated API and explicit UI notice choices.
Actions remains opt-in, runs recovery after successful or failed Python reviews,
excludes reading/test-notification modes and preserves failure/heartbeat ordering.
The local callback remains explicitly composed and disconnected from Vite.

Validation: compared implementation and fixture coverage with the stage-1 through
stage-4 acceptance recorded above and SPEC 14/15; checked the exact Git range,
clean starting worktree, environment template and whitespace. Previously accepted
unit/API/web/build/temporary-PostgreSQL/visual evidence is retained, not rerun or
represented as fresh execution. No automated local `/review` capability is
available; the exposed review tool requires an existing remote pull request.

Before a separately authorized deployment, verify the dedicated PostgreSQL 16+
login, actual TLS and session/pool compatibility, migration/API readiness and
free runtime usage. Before activation, agree exact baskets, configurations,
notice choices and real-send scope; reconcile attributable ordinary-run effects
afterward. These operational checks remain unproven by local fixtures. No remote
access, publication, promotion, migration, deployment, send or activation was
performed during this review. Next action belongs to the owner: decide whether
to authorize publication of this exact candidate; no operational action is queued.

### Authorized operational rollout of `88fa7e3` (17 Oct 2026, Lima)

The owner subsequently authorized promotion, deployment and real notifications,
then selected **Skincare only** for activation. Main now points to the exact
candidate `88fa7e3e96c3794cbcf967dbb5fa0923b6aa60af`; production deployment
`dpl_GhGhRotaAayegiGBjnvRizj6jAzC` is READY at
[Scrappy](https://scrappy-silk.vercel.app). Production authentication, the activation
preview and the current evaluation were verified over HTTPS before/after promotion.

PostgreSQL 17.11, verified client TLS using the official Supabase CA, exclusive
session-pooler connections, serializable transactions and the dedicated NOINHERIT
login passed live checks, including denied direct product writes. A backup of
public plus all three purchase-internal schemas restored locally: 33 tables,
309 rows. The activation migration preserved every existing table fingerprint.
The older public-only backup helper omitted trigger dependencies; its incomplete
restore was rejected before migration. The complete private backup is retained.

Skincare configuration 2 conserves its existing product, quantity and membership
identity, enables winner notices with minimum savings S/0.00, and leaves budget
notices off because no budget is configured. Yesstyle Skincare stays empty in
legacy mode by owner choice. Three runtime secrets were added to Actions without
altering the seven legacy secrets; `PURCHASE_WORKER_ENABLED=true` is now enabled.
These SQL credentials are confined to the local operator environment and Actions.

One manual normal `main/all` dispatch, [run 39089820904](https://github.com/SRT0808/Scrappy/actions/runs/39089820904),
reviewed two due products successfully and then committed one complete evaluation:
Skincare S/68.46, no conflicts, pending work or delivery attempts. The first
evaluation establishes the baseline; no winner transition or budget event existed,
so no new ntfy/email receipt is claimed. Earlier channel acceptance remains valid.
Healthchecks increased from 54 to 55 pings at 02:22:48 UTC, matching the successful
heartbeat step; it remains up with period 3h/grace 9h. Its read-only API hides the
ping URL, so this is receipt/step correlation rather than direct UUID inspection.

Cron-job.org job 8633587, its complete 3h schedule and original `main/all` payload,
Healthchecks configuration and existing firewall rules were preserved. Historical
price checks, basket snapshots/events, memberships and notifications were verified
unchanged; the normal run added its legitimate new price checks. The new deployment
error-log scan was empty. The repository is public and uses the existing standard
GitHub runner; no paid service was added. This single manual run does not claim a
new scheduler punctuality trial, repeat the closed §14.1 mission, or establish
provider-internal pooler-to-database TLS. Private evidence and the complete backup
are under `.scrappy/release-88fa7e3/`; no observer or follow-up was activated.

## Análisis UI/UX: simplificar el uso de Scrappy (18 oct 2026)

**Diagnóstico:** la interfaz pide comprender el modelo de datos antes de resolver
una compra. El problema principal es la organización del recorrido y de las
decisiones; recortar párrafos ayuda, pero deja intacta esa dificultad si siguen
apareciendo todos los campos y acciones a la vez. El dueño identifica Canastas y
alternativas como el principal punto de confusión durante sus pruebas.

Esta es una revisión heurística del código, de los recorridos y de las pruebas
existentes, contrastada con SPEC §11/11.1. No es una prueba nueva con usuarios ni
una inspección visual del despliegue. No se midieron tiempos, abandono, contraste
renderizado o altura de pantalla. No se cambió la interfaz ni la operación real.

### Qué necesita entender el usuario

Las preguntas de uso deberían guiar la interfaz:

1. ¿Qué quiero comprar y cuánto necesito?
2. ¿Qué productos o packs pueden servir?
3. ¿Qué opción cuesta menos y cuánto voy a pagar?
4. ¿Cuándo quiero que me avisen?

Hoy se mezclan esas preguntas con moneda, presupuesto, cobertura, ofertas,
alternativas, fijaciones, referencia, versiones y recibos. Necesidad y producto
sí deben distinguirse: necesitar un litro no es lo mismo que comprar una botella.
La interfaz puede explicar esa diferencia con cantidades y ejemplos al añadir
una opción, sin exigir editar por separado toda la estructura interna.

### Hallazgos priorizados en Canastas y alternativas

| Prioridad | Evidencia actual | Efecto en el uso | Cambio propuesto |
| --- | --- | --- | --- |
| Alta | [PurchaseEditor](src/components/PurchaseEditor.tsx#L15) muestra presupuesto/avisos, necesidades, ofertas/coberturas y alternativas/combos en un único formulario. | Una tarea sencilla exige decidir sobre todo el sistema. Hay que relacionar varios bloques para saber qué se está comprando. | Abrir en consulta. Entrar a editar mediante una acción explícita y guiar la creación desde «Qué necesitas» hasta «Opciones para comprarlo». |
| Alta | [PurchaseEditor](src/components/PurchaseEditor.tsx#L29) separa producto, cobertura, alcance de alternativa y cantidad de compras. Los nombres incluyen «oferta 1» y unidades como `unit`. | El usuario debe recordar qué número corresponde a qué producto y declarar relaciones que, en una compra simple, son redundantes. | Mostrar el nombre/tienda del producto dentro de cada opción y pedir contenido por presentación y cantidad deseada. Construir las relaciones simples desde esos datos; mantener combos y equivalencias explícitas. |
| Alta | [PurchaseBasketScreen](src/components/PurchaseBasketScreen.tsx#L80) titula el detalle «Necesidades y alternativas» y destaca versión/borrador. No recibe el nombre de la canasta. | Se pierde el contexto de «estoy mirando Skincare» y se presenta una tarea de configuración al entrar a consultar una compra. | Encabezar con el nombre de la canasta, total, estado y última actualización. Reservar versiones para diagnóstico o conflictos reales. |
| Alta | [PurchaseBasketScreen](src/components/PurchaseBasketScreen.tsx#L72) comunica tras guardar «no se ha activado la operación». La pantalla consulta al entrar y mediante «Consultar estado», sin seguimiento posterior del recálculo. | En una canasta ya activada, parece faltar otra activación. No se sabe si guardar recalcula, si se debe esperar o si actualizar inicia una revisión. | Separar «Cambios guardados» de «Cálculo pendiente». Explicar que el worker procesa en la próxima ejecución ordinaria y que actualizar solo consulta. No prometer un cálculo instantáneo con el contrato actual. |
| Alta | [PurchaseEditor](src/components/PurchaseEditor.tsx#L29) pide salir a Añadir producto para una URL nueva. [HomeScreen](src/components/HomeScreen.tsx#L94) intercambia pantallas y [PurchaseBasketScreen](src/components/PurchaseBasketScreen.tsx#L12) conserva el borrador solo en estado local. | Salir de la pantalla para añadir una URL puede perder el trabajo sin guardar. Consultar dentro de la pantalla sí conserva el borrador, como comprueban los tests; navegar fuera es otro caso. | Proteger la salida con cambios y mantener el contexto. Después integrar «Añadir por enlace» desde la opción, con retorno a la misma canasta y borrador. Evitar autoguardar publicaciones o repetir mutaciones ambiguas. |
| Alta | [PurchaseBasketScreen](src/components/PurchaseBasketScreen.tsx#L77) renderiza el detalle con historial solo en modo legacy. En alternativas muestra resultado, editor y recibos. | Activar alternativas cambia el recorrido y deja el historial anterior sin acceso desde ese detalle, aunque los datos se conserven. | Mantener una entrada de Historial en ambos modos, distinguiendo configuraciones. Revisar el contrato de lectura antes de reutilizar el componente legacy. |
| Media | [PurchaseResults](src/components/PurchaseResults.tsx#L15) muestra recomendación, ahorro y selección efectiva incluso cuando las dos compras coinciden; además expone IDs de lectura y cantidades con precisión interna. | Se repite información y cuesta distinguir recomendación de la compra que realmente determina el total. | Si coinciden, mostrar un único resumen. Si hay una opción fijada diferente, presentar «Tu elección» y «Opción más barata» con su diferencia. Formatear unidades y decimales; llevar IDs a detalles técnicos. |
| Media | [PurchaseActivation](src/components/PurchaseActivation.tsx#L73) aparece antes del detalle legacy, incluso para una canasta vacía. | La migración parece un paso obligatorio para usar cualquier canasta, antes de entender la ventaja de comparar opciones. | Ofrecer «Comparar opciones de compra» cuando sea pertinente. Mostrar las consecuencias y exigir las elecciones/confirmación al activar; conservar el uso básico sin conversión. |
| Media | [ListsScreen](src/components/ListsScreen.tsx#L108) presenta abrir, subir, bajar, renombrar, eliminar y «Canasta» en cada tarjeta. El último botón configura presupuesto/moneda. | El mismo nombre designa el objeto y una acción de significado distinto. Tareas de administración compiten con abrir la compra. | Una acción principal «Ver canasta»; presupuesto con nombre explícito; renombrar, ordenar y eliminar en acciones secundarias accesibles. |
| Media | [src/lib/purchases.ts](src/lib/purchases.ts#L47) devuelve un error general que agrupa cantidades, coberturas, límites y fijaciones; [PurchaseBasketScreen](src/components/PurchaseBasketScreen.tsx#L73) bloquea el guardado tras cualquier fallo. | No se sabe qué campo corregir y el siguiente paso puede parecer «consultar» incluso ante una entrada inválida. | Validación por campo/relación antes de enviar. Distinguir errores de entrada, conflicto y respuesta incierta, manteniendo la conciliación segura cuando no se conoce el resultado. |

La densidad también crece con los datos. Contando inputs, selects y checkboxes
del editor actual, sin botones ni extras: una necesidad, una oferta y una
alternativa muestran **17 controles**. Cuatro necesidades, seis ofertas y seis
alternativas generan **135**. Es un recuento del JSX repetido, no una medición de
una sesión: cada oferta crea un campo por necesidad, y cada alternativa vuelve
a mostrar todas las necesidades y todas las ofertas. Un acordeón sobre el mismo
formulario reduce la altura inicial, pero no resuelve por sí solo ese recorrido.

### Recorrido recomendado

**Consultar una canasta** debería mostrar primero el nombre, lo que necesitas,
el total que corresponde a tu elección y su estado. La recomendación más barata
sigue visible; si difiere de una fijación, la diferencia debe ser explícita.
Desde ahí: editar contenido, comparar opciones, configurar avisos o consultar
historial. La lista general necesita una tarjeta compacta, no repetir el detalle.

**Añadir una comparación** debería ser un recorrido corto:

1. «¿Qué necesitas?» — nombre, cantidad y unidad legible.
2. «Añade una opción» — elegir un producto seguido o leer una URL y confirmarla.
3. «¿Cuánto contiene esta presentación?» — con resumen de cuántas compras hacen
   falta. Por ejemplo, para 1 L: una botella de 1 L o dos de 500 ml. Ejemplo de
   SPEC, no productos reales ni una recomendación de compra nueva.
4. Revisar opciones y guardar; explicar cuándo estará disponible el cálculo.

Los combos que cubren varias necesidades siguen disponibles como opción
avanzada. Aceptar sobrantes o extras debe aparecer cuando el caso lo requiera,
con su consecuencia concreta; nunca marcarlo automáticamente para acortar pasos.
Las fijaciones y la referencia conservan sus reglas, aunque cambie su presentación.

### Texto: qué conservar, mover y cambiar

| Actualmente | Propuesta de lenguaje o ubicación |
| --- | --- |
| «Ofertas rastreadas y coberturas» | En el recorrido simple: «Opciones de compra» y «Contenido por presentación». |
| «Fijar [alternativa]» | «Usar siempre esta opción», explicando que puede costar más y que no se sustituirá si falla. |
| «Selección efectiva» | «Tu compra» o «Tu elección». |
| «Usar como referencia» | «Comparar el ahorro con…», manteniendo la referencia completa y factible. |
| «Avisar presupuesto» | «Avisarme cuando el total sea de … o menos». |
| «Avisar cambio de ganador» | «Avisarme cuando cambie la opción más barata», con ahorro mínimo dentro de esa configuración. |
| «Versión consultada… borrador basado en…» | Fuera de la consulta habitual; explicar la versión solo ante un conflicto o dentro del historial. |
| «Consultar estado» | «Actualizar resultado»; distinguirlo de solicitar una revisión de precios. |
| IDs de producto, oferta o lectura | Nombre legible; identificadores solo en diagnóstico desplegable. |
| Recibos JSON | Conservarlos en detalles de entrega; ya están colapsados, pero no deben definir el recorrido principal. |

Mantener visibles los problemas que afectan la decisión: compra incompleta,
precio antiguo, opción excluida, fijación inválida o cálculo limitado. No ocultar
estas advertencias para que la pantalla parezca más limpia. Las notas generales
sobre envío, cupones o stock pueden agruparse en una ayuda breve y accesible.

### Resto de pantallas

- **Productos:** [ProductCard](src/components/ProductCard.tsx#L24) acumula estado,
  precio, referencia, variación, meta, progreso, tendencia y varias explicaciones
  por tarjeta. Además, «Ver detalle» aparece antes del nombre/precio. Priorizar
  nombre, precio, meta, estado y actualización; mover la explicación del progreso
  y la ayuda de edición al detalle, sin quitar información necesaria de error.
- **Añadir producto:** [AddProduct](src/components/AddProduct.tsx#L191) muestra el
  formulario de selector CSS incluso tras una lectura correcta; método/confianza
  y la lista de candidatos añaden carga. Mantener URL → confirmar → aviso; desplegar
  diagnóstico solo cuando se solicite o falle la lectura. Si hay ambigüedad real,
  la selección de precio debe seguir siendo obligatoria.
- **Detalle de producto:** [ProductDetailScreen](src/components/ProductDetailScreen.tsx#L120)
  coloca editar, pausar, reparar, revisar, eliminar y tienda después del gráfico y
  estadísticas. Acercar las acciones frecuentes al resumen; poner reparación y
  eliminación en acciones secundarias, conservando confirmación destructiva.
- **Navegación móvil:** [HomeScreen](src/components/HomeScreen.tsx#L142) oculta
  Productos/Canastas/Ajustes en Menú. Valorar una navegación persistente compacta
  para esas tres secciones. El cambio de pantallas usa estado local y no un
  historial de rutas: revisar también Atrás, recarga y recuperación de contexto.
- **Ajustes y acceso:** son recorridos más acotados. Ajustes puede distinguir
  preferencias, prueba de canales y actividad. No es el primer lugar donde invertir
  mientras consultar/comparar una canasta siga resultando difícil.

### Orden de mejora y aceptación

1. **Primero, consulta clara de Canastas:** nombre/contexto, resumen compacto,
   edición bajo demanda, mensajes de guardado correctos y menos texto técnico.
   Mantener los contratos, cálculos, ejecución ordinaria y elecciones existentes.
2. **Después, editor guiado y continuidad:** añadir opciones por necesidad,
   productos/URLs en contexto, protección de borradores y errores específicos.
   Este lote sí requiere revisar estados de navegación y publicación.
3. **Restaurar continuidad del historial y avisos:** acceso coherente para ambos
   modos; comprobar qué información puede obtenerse con las API actuales.
4. **Extender a Productos y Añadir producto:** simplificación de tarjetas y
   diagnóstico progresivo, después de resolver el foco indicado por el dueño.

Validar en localhost con fixtures y emulación móvil: identificar qué comprar sin
abrir el editor; distinguir elección fijada de recomendación; crear una comparación
simple sin editar coberturas y alcance por separado; añadir una URL sin perder el
borrador; corregir un campo sin rehacer todo; entender que guardar no implica
recálculo inmediato; encontrar el historial. Comprobar también comparación parcial,
combo compartido y respuesta de guardado perdida. Registrar dónde hace falta
explicación del desarrollador, sin inventar ahora una puntuación de usabilidad.

Conservar el tema oscuro, Inter, el acento verde, el uso de controles semánticos
y los estados de carga/error existentes. Esta revisión no justifica cambiar el
stack, el motor de compra o los servicios. Las pruebas de código existentes
verifican comportamiento y seguridad; no demuestran que el recorrido sea intuitivo.

Los criterios de organización se apoyan en [mostrar las opciones avanzadas de
forma progresiva](https://www.nngroup.com/articles/progressive-disclosure/) y en
[reconocer información en lugar de recordarla](https://www.nngroup.com/articles/recognition-and-recall/).
Son fundamentos de las propuestas; los hallazgos concretos proceden del código
de Scrappy y deben contrastarse después con las tareas del dueño.

### Rediseño UI/UX implementado en local (18 oct 2026)

El dueño confirmó que se deben conservar todas las funcionalidades y la
profundidad del análisis. El cambio reorganiza cómo se encuentran y configuran
las opciones; conserva motor, contratos API/SQL, cálculos y operación automática.

- **Canastas:** la consulta abre con el nombre y los importes. Si una preferencia
  produce una compra distinta de la recomendación, se muestran ambas y se destaca
  el importe de tu elección. No se duplica el desglose cuando las compras coinciden.
- **Edición bajo demanda:** cuatro pasos —qué necesitas, opciones de compra,
  combos/preferencias y presupuesto/avisos— conservan el mismo borrador. Los
  controles avanzados siguen disponibles; cambiar de paso no publica ni recalcula.
- **Opción sencilla:** elegir necesidad, producto seguido, contenido y número de
  compras construye la oferta y alternativa explícitas. Conserva combos,
  referencias y fijaciones existentes; no acepta extras/sobrantes por el usuario.
  Presentaciones duplicadas y referencias solapadas tienen mensajes específicos.
- **URLs en contexto:** el flujo existente de lectura/confirmación se abre dentro
  de la canasta. El editor permanece montado y conserva campos, paso y borrador.
  Tras guardar el producto se actualiza el catálogo para poder seleccionarlo.
- **Cambios sin guardar:** navegación interna con confirmación de salida,
  protección de recarga y controles de navegación bloqueados durante las
  operaciones de la canasta. Las respuestas inciertas siguen requiriendo consulta
  y conciliación; no hay reenvío automático. Un error de entrada permite corregir.
- **Historial y activación:** acceso de lectura a las composiciones/snapshots
  conservados desde el detalle de alternativas. La comparación se ofrece después
  del uso básico legacy; activar mantiene elecciones explícitas y recibo durable.
  Se puede descartar una preparación que todavía no se haya enviado.
- **Menos texto inicial:** versiones, IDs y recibos técnicos quedan desplegables;
  precios incompletos, exclusiones, cálculos limitados y preferencias inválidas
  siguen explícitos. Guardar explica la espera hasta la próxima ejecución; actualizar
  consulta y no vuelve a guardar ni fuerza scraping.
- **Productos y navegación:** secciones persistentes en móvil, filtros/orden
  desplegables, acciones de producto junto al resumen y diagnóstico CSS opcional.
  Crear otra canasta y sus acciones administrativas son desplegables. Renombrar
  abre el formulario y enfoca el nombre. Se mantienen eliminar, ordenar, pausar,
  reparar, revisar ahora, presupuestos, cantidades y enlaces de tienda.

Validación Windows/local: build/typechecks y PWA (23 recursos) aprobados; 56 tests
de aceptación afectados y 37 de distribución/navegación aprobados en ejecuciones
dirigidas con solapamiento, más casos dirigidos de foco, historial y respuesta
incierta. Las regresiones de Añadir producto, Detalle y estadísticas también
pasaron; no se presentan esas cifras como una suma de tests únicos. Se revisaron
32 estados visuales a 320/390 px con fixtures locales, sin overflow ni errores JS,
incluidos consulta, cuatro pasos, preferencias, historial, guardado, confirmación
de URL, activación y cancelación. Las mutaciones del harness fueron exclusivamente
contra su servidor de fixtures. La web/API local devuelve el 401 esperado sin sesión.

Revisión manual de React, accesibilidad, conservación de borradores, CAS y
entregas ambiguas sin bloqueantes. No hay `/review` local automatizado disponible;
la herramienta conectada exige un PR remoto. Evidencia privada: `.scrappy/ux-*.log`
y `.scrappy/ux-visual/`. La versión de desarrollo está en
[localhost](https://localhost:5173/); esta tarea no publicó ni promovió a main.


### Rediseño publicado y verificado (18 oct 2026)

Con autorización explícita del dueño, el candidato `a899d87babcd81d15aca52bded2a042424d58b11`
se publicó en main y Vercel `dpl_Agpx1iY8SgUs8MnU6nirWL7m3e1W` quedó READY.
El alias [Scrappy](https://scrappy-silk.vercel.app) se comprobó contra ese deployment,
después de verificar su URL independiente. El override de build se aplicó solamente
a esta publicación; se conserva la política de builds automáticos y el firewall.

Verificación desplegada: sesión anónima 401, login y sesión autenticada 200,
consultas reales de listas, productos y ambas canastas 200; 39 estados visuales
a 320/390/1280 px, incluyendo resumen, cuatro pasos, editor avanzado, formulario
URL sin extracción, historial, productos/detalle, listado, ajustes y legacy.
Sin overflow ni errores JavaScript; el navegador de verificación permitió solo GET
sobre la API. No se guardaron borradores reales, activaciones ni notificaciones.
Los logs de errores de este deployment consultados durante el cierre estaban vacíos.

Comparación antes/después: cron-job.org 8633587, payload main/all cada 3h,
firewall, workflow, variable del worker, inventario de secretos y modos/versiones
sin cambios. Healthchecks está up con periodo 3h y gracia 9h. Solo Skincare
permanece en alternativas v2; Yesstyle Skincare permanece vacía en legacy v1.
El último ciclo ordinario observado fue 39165919660, exitoso antes de esta
publicación; esta mejora de interfaz no fuerza otro ciclo ni pretende acreditar
recepción nueva de avisos. No hubo migraciones ni cambios del backend/motor.
Evidencia privada: `.scrappy/release-a899d87/` (preflight, build, comprobaciones,
comparación operativa y capturas). La evidencia local del apartado anterior sigue
vigente; su referencia a no publicación describe el cierre local anterior.

### Acceso a conversión legacy visible (19 oct 2026)

Tras la prueba del dueño en Yesstyle, se movió «Configurar comparación» al inicio
del detalle de canastas legacy, inmediatamente debajo del título y antes del
resumen/productos. El texto indica que revisar la configuración no activa la
conversión y que esta solo se aplica tras confirmar. No modifica por sí mismo
la decisión de activar únicamente Skincare.

Commit `7c898171494d101d33ba123ad463b14e96c44c6c` está en main y READY en Vercel
como `dpl_5FmjfrmYtTfwvTqDjHpgWPFe22UT`. En el dominio estable se verificó Yesstyle
a 390 y 1280 px: el CTA aparece junto al título, abre la configuración y no
envía cambios; la API durante la revisión permitió exclusivamente GET. Build y
typechecks pasaron. Scheduler, firewall, workflow, variable/secrets de Actions y
modo legacy de Yesstyle / alternatives de Skincare se conservaron. Healthchecks
seguía up y el último ciclo programado observado terminó correctamente. La
composición legacy de Yesstyle ahora figura v3 con dos productos en la lectura
actual; no se restauró su composición anterior. Evidencia privada:
`.scrappy/release-7c89817/`.

### Espera al añadir un producto (2026-10-22, SPEC §11 y §14/15)

El run `39802417867` tardó 12 min 40 s en instalar dependencias del sistema
para Chromium, incluso con la caché de navegadores restaurada. APT descargó
25,9 MB en 11 min 55 s (36,3 kB/s), con reintentos de paquetes del mirror
de Ubuntu. La fase del scraper duró 11 s: la demora observada fue de preparación,
no de extracción. La lectura `20231a3b-a7a1-4eab-b19a-52e5eaed5d2f` terminó
`failed`, sin precio confiable; el run exitoso solo indica que el proceso terminó.
Evidencia de solo lectura: pasos de Actions, logs privados en
`.scrappy/reading-preparation.log` y estado persistido de esa lectura.

Añadir producto distingue cola/preparación (`queued`) y extracción (`reading`);
el contrato actual no identifica el paso exacto de preparación. Muestra tiempo
transcurrido desde la solicitud en esta pantalla, actualizado con cada consulta.
Consulta secuencialmente durante 20 minutos (cada 3 s al principio y cada 10 s
después del primer minuto), luego informa de la pausa sin declarar fallo.
«Consultar lectura» retoma consultas GET del mismo ID. Mientras siga pendiente
o su resultado sea incierto no permite cambiar URL ni salir con el botón del panel;
reintentar la creación requiere antes un GET 404 y conserva el ID original.
No se garantiza deduplicación entre pestañas o tras recargar/cerrar la pantalla.
La mejora conserva el workflow y el contrato API. Su promoción y despliegue fueron
autorizados por el dueño el 2026-10-22; el SHA y la aceptación se registran en STATUS.

### Identical offers with a shared goal: agreed behavior (2026-10-22)

Scope: extension of SPEC §11/11.1 and §14/15, defined with the owner.
Implementation, isolated local acceptance and code review are complete.
Development stays on develop; the owner authorized local promotion to main.
Publishing main, deployment and live migrations remain separate from local acceptance.

- A group represents offers explicitly declared by the owner to have the same
  formula, presentation and quantity. No automatic equivalence inference. Offers
  must use one currency and each offer belongs to at most one group. Combos stay
  separate and participate through existing basket alternatives.
- Products displays one group card in place of its offer cards. Group detail
  exposes the stores, their prices and histories. Creation supports dragging one
  offer onto another and an accessible Select → Group action, both followed by
  equivalence confirmation. Choose one offer as the initial name, image and common
  reference; edit the name/reference and choose an offer image before confirming.
- Add an existing tracked offer or paste a new URL from group detail. New URLs
  retain the normal reading/confirmation flow before explicit group membership.
  Each offer keeps its identity, URL, currency, extraction state, history and check
  interval. Existing baskets, quantities, alternatives and combos are unchanged;
  groups do not automatically replace basket offers or select stores for them.
- The shared goal controls goal notices while grouped. Preserve previous individual
  goals for restoration and suppress their individual goal notices while grouped.
  Operational extraction warnings retain their existing per-offer behavior.
  Define the common goal as an amount or a discount from an editable common
  reference. Persist the chosen input mode: reference edits preserve the entered
  percentage and recalculate the amount, or preserve the entered amount and
  recalculate its equivalent percentage. Show the outcome before saving.
- The graph shows one distinguishable, hideable line per offer, including history
  predating grouping, plus the current common goal line. Retain provenance and
  timestamps; do not invent missing prices or turn failures into zero. The current
  goal line does not represent historical goal configurations. A separate
  best-price history is outside the agreed first implementation.
- Evaluate the best confirmed, available, active, fresh, valid offer using existing
  validity rules. Failed, stale, suspicious, unavailable or paused offers are
  excluded explicitly. A valid offer may trigger the group goal even if another
  store is excluded; qualify the comparison as limited to verified offers. With
  no eligible offer, preserve alert state and wait; missing data is not a rise.
- One group goal event uses the existing independent ntfy/email delivery machinery.
  Another store reaching the goal does not itself repeat that notice. A further
  decrease of at least 5% from the last alerted price may notify again. Rearm when
  the best eligible price exceeds the goal by more than 3%. Store changes alone
  neither rearm nor trigger another notice.
- Creating a group, changing its target amount or adding an offer starts a new
  goal configuration eligible for notification at the next scheduled evaluation,
  even if already below target; warn before saving when currently known to meet
  the goal. Renaming, changing the image or editing a reference without changing
  the target amount does not reset alerts. Resuming notices, removing an offer
  and recovering valid readings preserve the last alert state and evaluate the
  normal rules, without an unconditional fresh notice.
- Pause group means pause its goal notices only: offer checks/history and baskets
  continue. Pausing an individual offer retains existing behavior and excludes
  it from group goal evaluation. Ungroup restores previous individual goals;
  removing an offer restores its previous goal, and leaving just one offer
  dissolves the group and restores that remaining offer's previous goal as well.
  Show these effects before confirmation. Ungrouping never deletes offers or
  history. Deleting an offer is a separate confirmed action showing group/basket
  consequences and preserving existing deletion rules.
- Notifications open the group in Scrappy, identify the triggering offer, its
  notified price and timestamp, and provide a store link. Distinguish the notified
  price from a later current price. Authentication remains required as usual.

Acceptance examples for the local implementation:

1. Group two identical PEN offers with references S/67.50 and S/69.90. Select
   S/69.90 as common reference and a 40% discount: both share target S/41.94.
   Existing offer IDs, observations, check intervals and basket configuration stay
   intact. Reject mixed currencies and already-grouped offers without moving them.
2. Group creation via drag and via selection reaches the same confirmation;
   cancellation leaves membership, individual goals and alert states unchanged.
   Mobile emulation and keyboard operation cover selection without dragging.
3. A valid S/40 offer meets S/41.94 despite another store's failed reading. One
   group event is produced; a later second store at S/40 does not duplicate it.
   No eligible offers preserves state, and recovery alone cannot reset it.
   Test exact 5% decrease and strictly-more-than-3% rearm boundaries.
4. For a 40% goal, changing reference S/69.90 → S/70 changes target to S/42;
   for an amount goal S/40, the same edit leaves target S/40. Only an actual
   target change resets the goal configuration. Saving makes no immediate send.
5. Pause group notices while offer checks continue. Resume without unconditional
   duplicate; retain normal crossing/additional-drop rules. Add an already-cheap
   offer with the pre-save warning and evaluate its new configuration next cycle.
6. Remove an offer and then dissolve a two-offer group: restore both original
   goals without losing histories or changing baskets. Distinguish this from
   deleting an offer. Display both store histories before/after the grouping date;
   a notice deep link shows the original offer/price/time even after price changes.

Local implementation accepted on 2026-10-22: migration
`20261022000000_product_groups.sql`, authenticated server API/contract, Python
group claims/delivery and Products group screens. Membership masks individual
goals without overwriting them; removing offers restores the original goals and
retains histories, intervals and basket configuration. SERIALIZABLE operations,
version checks, restricted RPC grants and RLS protect membership and delivery.
Individual sends reserve an offer for up to five minutes; grouping rejects an
active reservation and late expired receipts cannot update restored goals.
Both-channel individual failure permits the existing retry; group claims advance
state before delivery and never replay ambiguous receipts. An already authorized
external send cannot be recalled.

Acceptance combines the previously approved isolated PostgreSQL checks, 49 Python
tests, five API tests and affected web tests with the final passing catalog-return
regression, build/typechecks and local visual checks. The regression identifies
its offer by domain instead of relying on timestamp-dependent catalog order.
Eighteen visual states at 320/390 px cover catalog, detail, history, editor,
adding an existing offer, separation confirmation, individual offer management,
historical notice links and creation; no overflow or JavaScript errors. Private
visual evidence is in `.scrappy/group-visual/`. Manual review covers the complete
diff, authentication/RLS, membership and delivery races, restoration and UI flows;
no blocking findings remain.

Before publishing main, install this migration through a separately authorized
deployment operation and verify the deployed API and scraper contract together.
Pushing main automatically starts Vercel and makes the new scraper available to
the existing scheduler; local promotion alone does neither. No remote migration,
deployment or live notification was performed for this local acceptance.

### Groups production authorization sequence (prepared 2026-10-22 Lima)

Reviewed functional candidate: `570a75b` on local `develop` and local `main`.
Read-only remote inspection on this date found `main` at `0cf2305` and
`develop` at `a6220bb`. Recheck these references in the authorized window;
this preparation neither publishes branches nor authorizes production effects.
The accepted local tests above remain the development evidence.

1. **Authorize a bounded maintenance/release window.** Scope includes temporary
   access and dispatch exclusion, private backup, installation of only
   `supabase/migrations/20261022000000_product_groups.sql`, publishing the reviewed
   candidate, matching Vercel/API/scraper checks and restoration of prior access
   and scheduler states. A normal scraper cycle can send genuine individual,
   basket or group notices and write prices; include that effect explicitly if
   authorizing an operational check. Creating a real group or sending a test
   notification is a separate explicit choice. Scheduler credential rotation is
   still a separate pending security task; do not print or copy its token.
2. **Capture baseline and exclude writers.** Record actual serving deployment
   ID/SHA, remote main, installed schema/functions, scheduler/workflow states,
   pending/running runs and a private recoverable database backup. Confirm the
   installed dependencies through `20261017000000_purchase_activation.sql`,
   including `enter_purchase_operation` and the existing
   `save_product_alert_state(uuid,timestamptz,jsonb,jsonb)`. Compare their actual
   definitions to the reviewed migrations. Stop on drift or partial installation.
   Use the existing release exclusion procedure above: block API access including
   existing sessions and credential-bearing deployment URLs, disable scheduler
   dispatch and Check prices, stop local writers, and drain active requests and
   queued/running Actions. Reconcile interrupted delivery receipts before moving
   on. Verify the barrier actually works. Preserve Healthchecks 3h/9h and record
   the maintenance interval; do not revive historical commissioning experiments.
3. **Install SQL before publishing code.** With exclusion held, execute the one
   migration with stop-on-error. Its BEGIN/COMMIT is atomic; it is not idempotent
   (tables and the function rename prevent safe blind replay). On an uncertain
   result, inspect catalog definitions and commit outcome before retrying. Record
   migration hash and installation evidence privately. Confirm four new tables,
   RLS, SELECT-only service access on groups/members/events, no direct access to
   delivery reservations, and EXECUTE grants limited to the intended service RPCs.
   The renamed `save_ungrouped_alert_state` must not be callable by service_role,
   anon or authenticated. Check PostgREST schema reload and a service-side
   `read_product_groups` read returning an array, initially empty. Do not call
   `claim_product_group_events` as a read-only probe: it advances alert state.
4. **Verify environment and publish the exact candidate.** Inspect names and
   presence without logging values: existing server-only Supabase/auth/GitHub
   variables, notification secrets, `HEALTHCHECK_URL` and `PURCHASE_APP_ORIGIN`.
   The last is already wired in Actions and must be the actual HTTPS app origin;
   group processing validates it even when no groups exist. No new secret names,
   dependencies or workflow changes are required. Publish only after SQL checks;
   main publication starts Vercel and exposes the scraper to future dispatches.
   Keep dispatch disabled until the serving deployment is READY and its source
   matches the authorized functional candidate (documentation-only descendants
   must preserve that code). Do not assume a local main promotion is publication.
5. **Accept matching contracts before reopening.** Through the controlled access
   path, verify anonymous `/api/product-groups` returns 401, authenticated GET
   returns 200 with the validated group array, an absent UUID returns 404, and
   invalid/cross-origin mutations are rejected without writes. Verify products,
   baskets and histories against the captured baseline. Inspect installed RPC
   signatures against API and Python persistence calls, including individual
   begin/complete/finish reservations and group claim/finish. Reopen public access
   only after API/web checks pass; then enable Check prices for an explicitly
   authorized single normal cycle, with cron-job.org still disabled. Record the
   run's actual head SHA, persistence, group stage outcome, notice receipts and
   heartbeat. Reconcile failures/ambiguous sends without replaying claims. Empty
   groups demonstrate contract compatibility, not real group-notice acceptance.
   If that cycle was not authorized, retain operational acceptance as pending.
   Restore scheduler/workflow to the captured states only after the corresponding
   checks pass; preserve schedule/payload and Healthchecks settings.
6. **Stop and recovery rules.** Any schema, grant, contract or deployment mismatch
   keeps writers excluded; record the last successful step. Before SQL COMMIT,
   rollback the transaction. After COMMIT there is no reviewed groups down
   migration: prefer a reviewed forward fix. Do not drop tables or replay SQL.
   Returning to old API/scraper with live group memberships is unsafe: old sends
   lack the new reservation protocol. A database restore requires separate owner
   approval, matching baseline code and reconciliation of every intervening write
   and external receipt; sent notifications cannot be undone. Reopen only when
   the complete database/API/scraper combination has been verified. Record final
   deployment/SHA, migration, acceptance results and remaining limits in STATUS.

### Groups rollout stopped after SQL installation (2026-10-22 Lima)

The authorized window started at 12:47 Lima. Running CLI 63.1.2 directly renewed
the local session and restored firewall access. All 59 installed function
definitions matched the reviewed migrations. The quiescent backup restored in
isolation with 34 tables and 445 rows, including the three internal schemas.
Migration `20261022000000_product_groups.sql` committed once; existing data and
fixed-time totals, four new tables' RLS/grants, 13 function permissions and the
empty PostgREST group read passed. Remote main/develop were published at `570a75b`.

Deployment `dpl_BYAdVHPHnLBTLjkWUucW9FgnoNhG` built successfully but Vercel rejected
its 13 Functions with `exceeded_serverless_functions_per_deployment` (Hobby: 12).
The production alias still points to `dpl_E5zsDmhNh7Z6VjR63ErXzXCsZb3m`/`0cf2305`;
the project's production target metadata alone does not prove the serving alias.
Execution stopped under the two-failure rule after an unnecessary repeat of the
already-passed local comparison encountered existing roles and publication failed.
The temporary `Maintenance groups 570a75b` API deny remains active, verified with
a valid session on 15 hosts. Cron-job.org is disabled, Check prices is manually
disabled and no Actions runs are active. Healthchecks retains 3h/9h. No real
group, group event, delivery reservation or operational verification cycle was
created; application acceptance and operation restoration remain pending.

Resume with a reviewed packaging fix that preserves API routes within the free
12-Function limit, then complete the authorized contract checks, ordinary cycle
and restoration. Do not replay the committed migration or reopen old writers.
Private evidence: `.scrappy/release-570a75b/`, especially `backup/`,
`schema-comparison.json`, `migration.json`, `sql-verified.json`,
`deployment-error-events.json`, `function-file-inventory.json` and
`stopped-state.json`. Deployment/cycle authorization persists; database restore
and scheduler credential rotation remain separate decisions.

### Groups packaging deployed; operational acceptance stopped (2026-10-22 Lima)

Commit `e88ba21` was committed on develop and published to develop/main under the
existing release authorization. Login and logout now share `api/[auth].ts`, while
unchanged security handlers live outside api/. The 12-function source inventory
fits Hobby. The Python review step now receives the existing PURCHASE_APP_ORIGIN
secret required by group processing; no secret values or dependencies changed.
Deployment `dpl_DaWTF3pXQXjBUaAKxQyfUrUcc16g` is READY, with the production aliases
pointing to this SHA. The previously committed SQL migration was not replayed.

Fourteen auth tests, local HTTPS HTTP/1.1 and HTTP/2, build/typechecks and directed
manual review passed. The first local HTTPS attempt failed connecting to a random
localhost port; explicit IPv4 binding passed. Controlled production acceptance
passed 27 API/web checks, five auth route checks, and conservation of all 34
original tables, including product histories; groups remained empty. This does
not claim real group-notice acceptance.

The reopening verifier then expected anonymous API 401 on the secondary alias
scrappy-srt0808s-projects.vercel.app but received 302 to Vercel SSO. This is a
protected-access response; the public scrappy-silk.vercel.app contract had passed.
Execution stopped under the two-failure rule. Global API exclusion was restored
and verified as 403 with a valid session. Cron remains disabled, Check prices is
manually disabled, and no runs are active. No ordinary cycle was dispatched;
operational acceptance and restoration remain incomplete. Healthchecks remains
3h/9h. Resume by using authenticated CLI access for protected aliases, then
complete the already-authorized single ordinary cycle, reconciliation and
restoration. Do not replay migrations or probe claims. Private evidence remains
in `.scrappy/release-570a75b/`, especially `packaging-reviewed.json`,
`contract-accepted.json`, `auth-deployed-accepted.json`,
`secondary-reopen-response.json` and `packaging-stopped-state.json`.

### Protected aliases verified; ordinary cycle queued (2026-10-22 Lima)

The private reopening verifier now uses authenticated `vercel curl` for the two
protected current aliases and direct HTTP for scrappy-silk.vercel.app. All three
passed application 401 without a session and 200 with a session, including the
empty groups response. All 12 retired hosts returned WAF 403 with a valid session;
unrelated firewall rules were preserved. Deployment/SHA remains
`dpl_DaWTF3pXQXjBUaAKxQyfUrUcc16g` / `e88ba21`. SQL was not replayed.

The single authorized ordinary cycle was submitted once as
[Actions run 39829398992](https://github.com/SRT0808/Scrappy/actions/runs/39829398992).
After more than 21 minutes it still reported `queued`, with no jobs or checks.
No other repository run was active. Operational acceptance and scheduler
restoration are pending this external execution; do not submit another cycle.
Public API access is restored, Check prices is active for the accepted run, and
cron-job.org remains disabled with its schedule/payload preserved. Healthchecks
3h/9h was not changed. Continue by inspecting this exact run, reconciling its
database effects, delivery receipts and heartbeat, then restoring cron only on
success. No real group was created and real group-notice acceptance is not claimed.
Private evidence: `.scrappy/release-570a75b/reopened.json`, `ordinary-dispatch.json`,
`ordinary-current.json`, `ordinary-queue-audit.json` and
`protected-alias-pending-state.json`. Scheduler credential rotation remains separate.
