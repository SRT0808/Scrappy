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
