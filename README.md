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
