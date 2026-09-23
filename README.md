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

Two routes to the same number, and they agree.

`comparisonPrices` from the API supplies `{"value": 1.56, "unit": "g",
"quantity": 100}`, meaning $1.56 per 100 g. When it is absent, `packageSize` is
parsed and the unit price is derived from the shelf price. `unit_price_source`
records which route each row took, so a bug in the derivation can be corrected
later without distrusting API-supplied values.

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

- **No frontend yet.** Ingestion runs nightly and the history is accumulating,
  but nothing reads it. Search, the price history chart and the basket view are
  all still to build.
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
- **Observations before 2026-09-22 have no unit price.** The first two nights
  ran before `extract_unit_price` existed. Unit price is derivable from
  `price_cents` and `size_value`, both stored, so those rows can be filled by a
  view rather than by rewriting a stored price.
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
