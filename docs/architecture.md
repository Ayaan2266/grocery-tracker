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
│ ingest/normalize.py   │  shelf price ÷ package size; API as fallback
└──────────┬────────────┘
           │  NormalizedPrice
           ▼
┌───────────────────────┐
│ ingest/db.py          │  upsert products, record price changes
└──────────┬────────────┘
           ▼
┌───────────────────────┐
│ Supabase Postgres     │  price_spans: no price ever rewritten
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

**No price is ever rewritten.** Price history is the only asset in the
project a competitor cannot reproduce after the fact. Flipp and Gofer.run could
add a history feature tomorrow and still have no history. A price, once
written, stays exactly as written. A bad value gets corrected analytically
later via `unit_price_source`, never by overwriting it. Since `0006` this is
enforced by a trigger that binds every role, the owner that ingestion connects
as included, rather than by convention.

**Price changes are stored, not every night.** Storing one row per product
per night measured ~165 bytes a row and ~2.9 MB a night, which fills Supabase's
500 MB free tier in about five months. Grocery prices move weekly at most, so
most of those rows repeated the night before. `price_spans` holds one row per
unbroken stretch of identical values, `first_observed_on` to
`last_confirmed_on`. A night that sees the same values moves
`last_confirmed_on` forward. That one-column `UPDATE` is the only one the
trigger allows, and it can only move forward. In a 60-night simulation at full
size this was 8.7x smaller when every product changed weekly, and 18x smaller
at 5% a night.

The cost of storing only changes is telling "unchanged" apart from "we didn't
look". `ingest_runs` records which (store, day) pairs were actually ingested,
and a span is only extended if it was confirmed on that store's previous run.
A product missing from a run starts a new span when it returns, so the night
it was missing is never reported as observed. A night where the whole store
failed has no run, so a span can bridge it without claiming it.

The logical model did not change. `price_observations` is now a view that
rebuilds exactly one row per product per observed day (spans x runs). `0006`
converted the existing history and refused to commit unless that view matched
the original table row for row. A same-day re-run is still idempotent: a product
already confirmed today is left exactly as written, and its span's
`(product_id, first_observed_on)` key is `ON CONFLICT DO NOTHING`.

`products` is the deliberate exception and upserts on
`(store_id, retailer_sku)` with `DO UPDATE`. Product metadata is mutable —
names and package sizes get re-worded upstream, and the newest rendering is
the one worth keeping. The no-rewrite rule governs prices, not identity. That
is also why `comparison_unit` and `comparison_quantity` stay with the price
rather than moving to `products`. They can differ between nights, and a
column on a table that is overwritten nightly would silently re-scale every
historical unit price.

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

**`unit_price_source` column.** Records whether a unit price was derived from
the shelf price and `packageSize`, came from the API's `comparisonPrices`, or is
unavailable. Keeping the provenance means a bad route can be found and corrected
later without re-deriving the whole table. It has already paid for itself: the
808 rows written on 2026-09-23 while the API's figure came first are all
`api`, which is how they can be told apart from what came after.

**Unit prices follow the shelf price, not the API.** The API's
`comparisonPrices` looked like the authoritative figure, and it agreed with
the shelf price on every product checked by hand. The first full-catalogue
check disagreed on 21% of Superstore products. Nearly all were deals the API
reports without a `wasPrice`, where its unit price stays on the regular price.
A unit price must describe the price that was actually charged, so it is
derived from the shelf price whenever the package size parses. The API fills
in otherwise and stays as a nightly cross-check.

**Inferred prices never go in observed columns.** The API's unit price on
those deals reveals the regular price, and `implied_regular_cents` stores it
(`0007`). It could have gone into `was_price_cents`, which the frontend
already shows as "was $X". It deliberately does not. `was_price_cents` is what
the retailer declared and `implied_regular_cents` is what we worked out,
approximately, from a figure the retailer rounded. Keeping them apart means
either can be trusted, or corrected, without doubting the other.

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
