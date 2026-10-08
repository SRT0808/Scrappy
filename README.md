# Scrappy

Personal, free price tracker. The local foundations are ready; the scraper engine,
database connection, notifications, API and web app are still pending.

## Local setup (PowerShell)

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ./scraper
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m scrappy.run --mode all
```

Python 3.11+ is required. The CLI currently validates its arguments and exits
without fetching pages, connecting to Supabase or sending notifications.
Supported modes are `all`, `product` (requires `--product-id`) and
`test_notification`. `.env` is reserved for future integrations; the scaffold
does not load it. Keep all credentials out of source control and client code.

## GitHub Actions scaffold

`check-prices.yml` provides a three-hour schedule and manual dispatch, a shared
concurrency group, a 20-minute timeout, pip/browser caches and the empty CLI run.
GitHub schedules use the default branch; this task only prepares `develop`.
Configure the secrets listed in SPEC section 12 when integrating external
services. `HEALTHCHECK_URL` is optional for the scaffold: when set, the workflow
pings it after success, or its `/fail` URL on failure.

Each execution reports elapsed runner time in the Actions summary. This is not
account billing usage: verify the current free-minute allowance and actual
account consumption before activating production scheduling.
As checked on 2026-10-08, GitHub Free includes 2,000 minutes per month for private
repositories, shared across the owner's account ([GitHub billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
