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

Flipp and reebee aggregate weekly flyers — they show what is *on sale*, not what
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
  normalize.py        unit-price extraction and validation
  match.py            cross-banner product matching
  db.py               append-only writes
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

psql "$DATABASE_URL" -f db/migrations/0001_init.sql

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

## What doesn't work yet

Maintained honestly. Overclaiming reads as junior.

- **Unit price is NULL on every row.** Both `extract_unit_price` (read the
  API's pre-normalized `comparisonPrices`) and `parse_package_size` (the
  fallback for entries that return an empty one — mostly sold-by-each items and
  weighted produce) are stubs that return `None`, so every observation lands
  with `unit_price_source = "none"`. Shelf prices and sale flags are stored
  correctly. Unit price is a convenience column, and a NULL is recoverable
  where a wrong value silently poisons every comparison built on top of it.
- **Cross-banner matching is a skeleton.** `match.py` documents the approach and
  the identity-vs-substitutability distinction but proposes nothing yet. By
  design: the spec says not to design matching before there is real messy data
  to look at.
- **Three banners, three stores.** Zehrs, Maxi and Fortinos need verified
  store codes first; guessed codes return 200 with zero results, which is
  indistinguishable from a working store with nothing in stock.
- **No precision/recall numbers on matching.** They go here once there are
  hand-labelled pairs to measure against.
- **Server-side API access is unverified.** The contract was confirmed from
  inside the browser, which carries cookies and an `Origin` header that GitHub
  Actions does not. See the open items in
  [docs/data-sources.md](docs/data-sources.md).

## Legal

Personal, non-commercial project. Not affiliated with, endorsed by, or
connected to Loblaw Companies Limited or any retailer. It uses an undocumented
internal API, which is against Loblaw's terms of service; requests are rate
limited to roughly 1/second and responses are cached. Sustained 403s or a key
rotation are treated as a stop signal.
