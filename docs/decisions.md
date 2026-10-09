# Decisions

- 2026-10-08: Pin Scrapling with its fetchers extra to 0.4.15 and use Python 3.12 in CI to match the available local runtime.
- 2026-10-08: Phase 0 writes completed zero-check runs through the Supabase REST API using Python's standard library; list deletion is restricted while products exist, product history cascades, and notification records retain a nullable product reference.
- 2026-10-08: Persist Scrapling 0.4.15 adaptive fingerprints as versioned, per-product JSON in domain_recipes.adaptive_state; CSS remains primary and relocated prices require confirmation rather than trusting ephemeral SQLite/cache files.
- 2026-10-08: Use existing notification attempts since last_success_at to throttle read-failure reminders, including failed deliveries; goal state changes only after confirmed delivery. External sends are at-least-once across process/database failures; serialize runners and guard state writes against stale reviews.
- 2026-10-08: Count all admitted login attempts, including successes, in a rolling five-per-IP/15-minute window; an invoker-security service-role RPC takes a transaction advisory lock before counting/inserting so serverless concurrency cannot exceed the limit.
- 2026-10-08: Confirm the session through the API after login before displaying the workspace, so rejected secure cookies cannot produce a falsely authenticated UI; keep all credentials and tokens out of browser storage.
- 2026-10-08: Serialize list mutations with an invoker-security service-role RPC and a table lock; reorder requires the complete ID set, deletion retains the existing nonempty-list restriction and compacts positions, names allow 100 Unicode code points and emoji 16.
