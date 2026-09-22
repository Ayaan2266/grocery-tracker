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
tomorrow and still have no history. Its `ON CONFLICT` clause targets
`(product_id, observed_on)` and is `DO NOTHING`, so re-running a failed ingest
the same day is idempotent: rows already written stay exactly as they were
written. A bad value gets corrected analytically later via `unit_price_source`,
never by overwriting history.

`products` is the deliberate exception and upserts on
`(store_id, retailer_sku)` with `DO UPDATE`. Product metadata is mutable —
names and package sizes get re-worded upstream, and the newest rendering is
the one worth keeping. The append-only rule governs observations, not
identity.

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

**Units canonicalise to three dimensions.** `g` and `kg` both become grams,
`ml` and `l` both become millilitres, `ea` stays as it is. `comparison_unit` is
a join key rather than a display label: two products only compare when their
units agree exactly, so without this the 2,715 products written in `l` or `kg`
(13.8% of the catalogue) could never compare against the 15,115 written in `g`
or `ml`, even though `1 l` and `1000 ml` are the same quantity of the same
thing. `package_size` keeps the retailer's raw string, so canonicalising costs
no fidelity.

The three dimensions are deliberately not interconvertible. Mass to volume
needs a density that is not in the payload, and `ea` has no magnitude at all,
so the unit travelling with each row is what prevents a downstream query
comparing across them by accident. Both the API path and the fallback parser
use the same conversion table, because if they used different ones they could
disagree about what a gram is and the disagreement would only surface as a
wrong price comparison months later.

**Matching is a separate, reviewed step.** `match.py` proposes candidates; it
does not write to `product_matches`. An unreviewed matcher silently poisons
every downstream price comparison, and a wrong "cheaper at Superstore" claim is
worse than no claim.

## Known limitations

See the "What doesn't work yet" section of the root README. That list is
maintained deliberately — overclaiming reads as junior.
