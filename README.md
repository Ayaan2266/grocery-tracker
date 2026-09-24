# Canadian Grocery Price Tracker

[![CI](https://github.com/Ayaan2266/grocery-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/Ayaan2266/grocery-tracker/actions/workflows/ci.yml)
[![Nightly ingest](https://github.com/Ayaan2266/grocery-tracker/actions/workflows/ingest.yml/badge.svg)](https://github.com/Ayaan2266/grocery-tracker/actions/workflows/ingest.yml)

**Live:** _deploying week 2_

Daily store-level price history for Canadian groceries, across Loblaw-owned
banners (No Frills, Real Canadian Superstore, Loblaws). It answers two
questions:

1. Which store near me is cheapest for this basket right now?
2. Is today's price actually a good deal, or is it the normal price with a sale
   sticker on it?

## Why this exists

Flipp and reebee aggregate weekly flyers: they show what is *on sale*, not what
is *cheapest*, and they depend on retailers uploading flyers. Gofer.run compares
live prices across stores by postal code. None of them keep price history.

There is no CamelCamelCamel for Canadian groceries. That gap is the project.
Price history cannot be retrofitted: a competitor who adds the feature tomorrow
still starts with zero days of data. Running ingestion continuously is the moat
and it is also the only part that cannot be built in a weekend.

## Architecture

Python ETL on scheduled CI → Postgres time-series → Next.js frontend.

```
GitHub Actions cron → ingest/ (httpx + pydantic) → Supabase Postgres → Next.js on Vercel
```

See [docs/architecture.md](docs/architecture.md) for the decisions and
[docs/data-sources.md](docs/data-sources.md) for the verified API contract.

| Layer | Choice |
|---|---|
| Ingestion | Python 3.12, httpx, pydantic |
| Scheduler | GitHub Actions cron |
| Database | Supabase (Postgres) |
| App | Next.js 15, TypeScript, Tailwind |
| Charts | Recharts |
| Hosting | Vercel |

Total infrastructure cost: $0.

## Repository layout

```
.github/workflows/    ingest.yml (nightly cron), ci.yml (ruff + pytest + next build)
ingest/
  sources/loblaw.py   rate-limited PCX client, canary store verification
  normalize.py        unit-price extraction, canonical units, validation
  match.py            cross-banner product matching
  db.py               writes price changes; history is never rewritten
  money.py            dollars to integer cents, in one place
  config.py           environment settings, rate-limit floor
  run.py              CLI entry point
  targets.json        3 stores x 167 search terms (data, not code)
  tests/              offline; respx intercepts every outbound request.
                      test_db_integration.py needs a Postgres and skips without one
db/migrations/        numbered SQL
web/                  Next.js app
docs/                 architecture and data-source notes
```

## Running it

```bash
cp .env.example .env          # fill in PCX_API_KEY and DATABASE_URL
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done

python -m ingest.run --dry-run                       # fetch, normalize, write nothing
python -m ingest.run --dry-run --limit 3 -v          # ~10s smoke test
python -m ingest.run --store nofrills/3131           # one store only
python -m ingest.run                                 # full run, writes to Postgres

ruff check ingest && pytest -q
```

The write-path tests need a real Postgres and skip silently without one. CI
provides it; locally:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export INGEST_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
pytest -q
```

They run inside a throwaway schema that is dropped afterwards, so the target
database is left as it was found.

```bash
cd web && npm install && npm run dev
```

## Unit prices

The unit price is the shelf price divided by the package size: what you
actually pay, per 100 g, per 100 ml or per 1 each. `packageSize` parses for
99.9% of products. For the rest, the API's own `comparisonPrices` fills in,
rescaled onto the same basis. `unit_price_source` records which route each row
took.

The API's figure used to come first. The first live cross-check (2026-09-23)
retired that: on 21% of Superstore products the shelf price is discounted with
no `wasPrice`, and the API's unit price stays on the regular price. Mango
Nectar, 960 ml at $1.50, reported $0.24/100 ml, the price of a $2.30 bottle. The
two figures are still compared every night, and the count of disagreements is
in the run summary.

Everything folds onto three canonical dimensions:

| written as | stored as |
|---|---|
| `g`, `kg` | grams |
| `ml`, `l` | millilitres |
| `ea` | each |

That conversion is not cosmetic. 2,715 products (13.8% of the catalogue) are
written in `l` or `kg`; left verbatim they would form a second bucket that
could never compare against the 15,115 written in `g` or `ml`, even though
`1 l` and `1000 ml` are the same quantity of the same thing. `package_size`
keeps the retailer's raw string, so nothing is lost.

Grams, millilitres and each are deliberately not comparable with each other.
The density to convert mass to volume is not in the payload and `ea` has no
magnitude, so the unit travels with the row and stops a downstream query
comparing across dimensions by accident.

## What doesn't work yet

Maintained honestly. Overclaiming reads as junior.

- **Store comparisons only match identical products.** Search, product pages
  with a price-history graph and a "good price?" verdict, and a basket priced at
  every store all work. But "same item at other stores" and the basket's store
  totals pair listings by their PCX product code, so they only find the exact
  same product. A store brand's equivalent is a different code, and pairing
  those is what `match.py` is for. The basket lives in a cookie, so it belongs
  to one browser.
- **Verdicts rest on days, not months, of history.** Tracking started on
  2026-09-21, so "lowest price recorded" means lowest in that window. The
  product page says how many days it is based on.
- **Unit price is unavailable for 0.12% of products.** 16 are measured in
  metres (foil, plastic wrap), 7 in sheets or packs. They have no mass or
  volume, so they get a NULL rather than a fabricated number.
- **Cross-banner matching is a skeleton.** `match.py` documents the approach and
  the identity-vs-substitutability distinction but proposes nothing yet. By
  design: the spec says not to design matching before there is real messy data
  to look at. There is now real messy data to look at.
- **Three banners, three stores.** Zehrs, Maxi and Fortinos need verified
  store codes first; guessed codes return 200 with zero results, which is
  indistinguishable from a working store with nothing in stock.
- **No precision/recall numbers on matching.** They go here once there are
  hand-labelled pairs to measure against.
- **Most prices first seen before 2026-09-24 have no unit price.** Every run
  before 12:43 UTC on 2026-09-23 used code whose unit-price extraction was a
  stub, and 808 rows from that run took the API's figure, which is wrong on
  undeclared deals. `unit_price_source` identifies both groups, and unit price
  is derivable from `price_cents` and `size_value`, both stored, so they can
  be corrected by a view rather than by rewriting a stored price.
- **The regular price on unmarked deals is an estimate.** About a fifth of
  Superstore's products are discounted with no `wasPrice`. Since `0007` their
  regular price is rebuilt from the API's unit price into
  `implied_regular_cents`, and search results show it as "usually ~$2.30".
  The API rounds its unit price to the cent per 100 g, so it can be a few
  cents out, and history before 2026-09-24 does not have it.
- **The storage growth figure is simulated, not measured.** One row per product
  per night was measured at ~165 bytes and ~2.9 MB a night, enough to fill
  Supabase's 500 MB free tier around March 2027. Storing changes only (`0006`)
  measured 8.7x smaller in a 60-night simulation where every product changes
  weekly, and 18x smaller at 5% a night. How often real prices change is
  unknown until a few nights after `0006`; the query in
  [db/migrations/README.md](db/migrations/README.md) gives the real ratio.

## Legal

Personal, non-commercial project. Not affiliated with, endorsed by, or
connected to Loblaw Companies Limited or any retailer. It uses an undocumented
internal API, which is against Loblaw's terms of service; requests are rate
limited to roughly 1/second and responses are cached. Sustained 403s or a key
rotation are treated as a stop signal.
