# Architecture

```
GitHub Actions (cron 03:10 ET)
        │
        │  python -m ingest.run
        ▼
┌───────────────────────┐
│ ingest/sources/       │  httpx, 1 req/sec, canary-verified storeIds
│   loblaw.py           │
└──────────┬────────────┘
           │  pydantic models (extra="ignore")
           ▼
┌───────────────────────┐
│ ingest/normalize.py   │  comparisonPrices → unit price; fallback parser
└──────────┬────────────┘
           │  NormalizedPrice
           ▼
┌───────────────────────┐
│ ingest/db.py          │  upsert products, append price_observations
└──────────┬────────────┘
           ▼
┌───────────────────────┐
│ Supabase Postgres     │  price_observations is APPEND-ONLY
└──────────┬────────────┘
           │  anon key, RLS read-only
           ▼
┌───────────────────────┐
│ Next.js on Vercel     │  search, price history chart, basket view
└───────────────────────┘
```

## Decisions and why

**GitHub Actions as the scheduler, not a server.** The job runs once a night
for a few minutes. A VM or a container platform would cost money and add an
operational surface for zero benefit, and the workflow file is visible proof of
scheduled CI to anyone reading the repo.

**`price_observations` is append-only.** Nothing ever updates a historical
price. This table is the only asset in the project a competitor cannot
retroactively reproduce — Flipp and Gofer.run could add a history feature
tomorrow and still have no history. The one `ON CONFLICT` clause targets
`(product_id, observed_on)` so that re-running a failed ingest the same day is
idempotent rather than duplicating rows.

**Money is integer cents everywhere.** No float dollars in the database, in the
Python models, or in the API responses the frontend consumes. Formatting
happens once, at the edge, in `formatCents`.

**`extra="ignore"` on every pydantic model.** The upstream API is undocumented
and adds fields without notice. A new field must never fail a nightly run.
Conversely, a *removed* field surfaces as a validation error on a required
field, which is exactly when a loud failure is wanted.

**Canary verification before every store's ingest.** A bad `storeId` returns
HTTP 200 with zero results. Without a guard, a store code that changes upstream
produces months of successful-looking empty runs, and the price history — the
entire point — is silently missing. `verify_store` searches for terms every
grocery store stocks and raises if none return.

**`unit_price_source` column.** Records whether a unit price came from the API's
`comparisonPrices`, was derived from `packageSize`, or is unavailable. Keeping
the provenance means a bug in the derivation can be found and corrected later
without re-deriving the whole table or distrusting the API-supplied values.

**Matching is a separate, reviewed step.** `match.py` proposes candidates; it
does not write to `product_matches`. An unreviewed matcher silently poisons
every downstream price comparison, and a wrong "cheaper at Superstore" claim is
worse than no claim.

## Known limitations

See the "What doesn't work yet" section of the root README. That list is
maintained deliberately — overclaiming reads as junior.
