# Scrappy

Personal, free price tracker. Phase 0 records empty runs in Supabase and pings
Healthchecks.io from Actions. The scraper engine, notifications, API and web app
are still pending.

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
It does not yet fetch pages or send notifications.
Supported modes are `all`, `product` (requires `--product-id`) and
`test_notification`. The CLI reads process environment variables; `.env` is loaded
by the PowerShell snippet above. Use unquoted values. Keep all credentials out of
source control and client code.

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
