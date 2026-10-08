# Decisions

- 2026-10-08: Pin Scrapling with its fetchers extra to 0.4.15 and use Python 3.12 in CI to match the available local runtime.
- 2026-10-08: Phase 0 writes completed zero-check runs through the Supabase REST API using Python's standard library; list deletion is restricted while products exist, product history cascades, and notification records retain a nullable product reference.
- 2026-10-08: Persist Scrapling 0.4.15 adaptive fingerprints as versioned, per-product JSON in domain_recipes.adaptive_state; CSS remains primary and relocated prices require confirmation rather than trusting ephemeral SQLite/cache files.
