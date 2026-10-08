# Scrappy

Personal, free price tracker. The phase-one probe evaluates product extraction;
the scheduled scaffold records empty runs in Supabase and pings Healthchecks.io.
The review/alert engine, notifications, API and web app are still pending.

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

Python 3.11+ is required. The CLI validates its arguments and records a completed
zero-check row in `runs`; connection errors exit nonzero with no credentials in logs.
The scheduled entry point does not yet fetch pages or send notifications.
Supported modes are `all`, `product` (requires `--product-id`) and
`test_notification`. The CLI reads process environment variables; `.env` is loaded
by the PowerShell snippet above. Use unquoted values. Keep all credentials out of
source control and client code.

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
Candidate selection/teaching UI and review-time price-change validation are pending.

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

## Supabase setup

Create a Free project and apply `supabase/migrations/20261008000000_initial_schema.sql`
once, using the Dashboard SQL editor or `psql` with the connection string stored
locally in `SUPABASE_DB_URL`. With the environment loaded as above:

```powershell
psql --dbname=$env:SUPABASE_DB_URL --set=ON_ERROR_STOP=1 --file=supabase/migrations/20261008000000_initial_schema.sql
```

Use the session pooler connection if direct Postgres IPv6 is unavailable. All eight
tables have RLS enabled, no public policies, and no `anon`/`authenticated` grants.
Only trusted server code uses `SUPABASE_SERVICE_ROLE_KEY`. The migration is
transactional; do not rerun it on an already initialized database.
`SUPABASE_ACCESS_TOKEN` is an optional local management alternative to a database
connection; neither setup credential belongs in Actions or Vercel.

## GitHub Actions scaffold

`check-prices.yml` provides a three-hour schedule and manual dispatch, a shared
concurrency group, a 20-minute timeout, pip/browser caches and the connected empty CLI run.
GitHub schedules use the default branch, currently `develop`.
Set repository Secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
`HEALTHCHECK_URL` before dispatching this phase. The heartbeat is required and
uses the check's `https://hc-ping.com/<uuid>` URL after success, or `/fail` on
failure. Configure the other secrets in SPEC section 12 when implementing notifications.
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
