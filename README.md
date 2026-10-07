# Canadian Grocery Price Tracker

[![CI](https://github.com/Ayaan2266/grocery-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/Ayaan2266/grocery-tracker/actions/workflows/ci.yml)
[![Nightly ingest](https://github.com/Ayaan2266/grocery-tracker/actions/workflows/ingest.yml/badge.svg)](https://github.com/Ayaan2266/grocery-tracker/actions/workflows/ingest.yml)

**Live:** _launching on Vercel in October 2026_

Daily store-level price history for Canadian groceries, from seven stores
across six Loblaw-owned banners (No Frills, Real Canadian Superstore, Loblaws,
Zehrs, Fortinos, Maxi), checked every night since 2026-09-21. It answers two
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

## What the site does

- **Search** every store's latest price, cheapest first or by unit price
  (per 100 g, per 100 ml, each), with a 7-day sparkline and a badge from the
  last 30 days: lowest recorded, below typical, above typical, or steady.
- **Product page:** the full price history as a chart, a verdict on whether
  today's price is a good one, the same item at every other store, and
  similar items from other brands ranked by unit price.
- **Basket:** add items from any store and see what the whole list costs at
  each store, which store has everything for least, and what a mix of stores
  would save.
- **Stores:** Ontario stores by default, every store with one click, or the
  stores within a radius of a postal code. Only the first three characters
  of the postal code are used.
- **How it works:** the nightly check explained, with live status from last
  night's run and a worked example of a verdict.

Pages render on the server. Search, the basket and the store picker are plain
forms that work with JavaScript off; only the price chart needs it. The basket
and the store choice are cookies, so there are no accounts.

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
| App | Next.js 15 (App Router, server components), TypeScript, plain CSS |
| Charts | Recharts |
| Hosting | Vercel |

Total infrastructure cost: $0.

## Repository layout

```
.github/workflows/    ingest.yml (nightly cron + manual tasks), ci.yml (ruff + pytest, eslint + web tests + next build)
ingest/
  sources/loblaw.py   rate-limited PCX client, canary store verification, store list
  normalize.py        unit-price extraction, canonical units, validation
  match.py            cross-store matching keys, and a read-only report of what they pair
  stores.py           finds and canary-checks store codes for new banners
  db.py               writes price changes; history is never rewritten
  money.py            dollars to integer cents, in one place
  config.py           environment settings, rate-limit floor
  run.py              CLI entry point
  targets.json        7 stores x 167 search terms (data, not code)
  tests/              offline; respx intercepts every outbound request.
                      test_db_integration.py needs a Postgres and skips without one.
                      fixtures/labelled_pairs.json: hand-labelled matches
db/migrations/        numbered SQL, 0001 to 0012
db/queries/           read-only diagnostics, including the weekly storage report
db/ops/               nightly_dispatch.sql: starts the nightly run on time from Supabase
web/                  Next.js app
  src/app/            pages: search (/), /product/[id], /basket, /how-it-works,
                      and the server actions behind the basket and store forms
  src/components/     price chart, sparklines, result rows, store picker
  src/lib/            Supabase queries, cross-store matching, basket pricing,
                      price-history verdicts, postal codes; tests beside each (*.test.ts)
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

python -m ingest.stores discover zehrs --near 43.65,-79.38   # list stores, canary-check the nearest 3
python -m ingest.stores verify zehrs/0552                   # canary-check one code
python -m ingest.match report                               # what matching pairs, read-only
```

The last three need the same secrets as the nightly run, so they also run as
manual tasks of the `ingest` workflow (Actions -> Nightly ingest -> Run
workflow -> task). None of them writes anything.

The nightly run is started at 07:10 UTC by Supabase, which sends the workflow
a "Run workflow" request (`db/ops/nightly_dispatch.sql`): GitHub's own schedule
started every run 5 to 8 hours late. That schedule stays as the fallback, and
`--once-per-day` makes whichever run comes second stop before any request. To
re-run a night on purpose, run the workflow with `force` ticked.
The Supabase job was set up on 2026-10-02 and a test dispatch was accepted
(204), so the first on-time night is the 10-03 run. It authenticates with a
fine-grained GitHub token kept in Vault as `github_dispatch_token` (Actions:
read and write, this repository only). The token expires; when it does the
dispatch fails with 401 and nights fall back to GitHub's late schedule, so
replace it with `vault.update_secret` (steps in `db/ops/nightly_dispatch.sql`)
before then. To check a night, the morning after:

```sql
select status_code, error_msg, created from net._http_response order by created desc limit 5;
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
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

The site needs only the Supabase URL and the anon key, which can read and
nothing else (see `db/migrations/0003_enable_rls.sql`):

```bash
cd web
cp .env.example .env.local    # fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm install
npm run dev                   # http://localhost:3000

npm run lint && npm test && npm run build    # what CI runs
```

Without them the site still builds and runs, and says price data is
unavailable.

## Deploying

The site runs on Vercel. The nightly ingest stays on GitHub Actions; Vercel
never holds `DATABASE_URL` or the PCX key.

1. Import the repository in Vercel and set **Root Directory** to `web`. The
   framework is detected as Next.js; the build command is `next build`.
2. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the
   anon or `sb_publishable_` key) for Production and Preview.
   `POSTAL_GEOCODER_URL` is optional (`web/.env.example`).
3. Set the function region as close to the database as Vercel offers. The
   Supabase project is in `ca-central-1` (Montréal), and a page makes two or
   three queries in a row, so each one pays the round trip.
4. Apply any migration the code needs before it deploys: Actions -> Nightly
   ingest -> Run workflow -> task `migrate`. `0012` is an index the product
   page benefits from; nothing breaks without it.

Every push to `main` deploys, and every pull request gets a preview. Previews
read the same database as production, which is safe because the key cannot
write.

In production the site sends security headers on every response (no framing,
no MIME sniffing, a strict referrer policy), marks its cookies `Secure`, and
keeps the store list, coverage counts and how-it-works status in Next's data
cache for 15 minutes, since they change once a night.

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

- **Matching favours precision over recall.** A product page shows the same
  item at every store that carries it, by the product code the stores share
  or, where Superstore lists it under its own code, by brand, name and exact
  package. A second section lists similar items (other brands with the same
  description and size) by unit price, and the basket points out one per line
  when it is cheaper per unit; neither ever counts in a basket total. Against 270 hand-labelled real pairs
  (`ingest/tests/fixtures/labelled_pairs.json`, labelled by hand, worth a
  second look) no identity and no substitute was wrong, but on the pairs
  picked without the matcher's help it found 17 of 22 real matches (it was 14
  until the size allowance, "original"/"classic" and "disinfecting" rules
  below). A similar item's size may differ by up to 3% (148 ml against
  150 ml, 40 lb against 18 kg of rice), and "Original" or "Classic" in a name
  no longer separates it from the same product without; identity matches
  still need the exact package and every word. It still misses a different
  word on each side ("Jasmine Rice Milagrosa" against "Jasmine Rice"), a
  product line in the name ("Naturegg"), a different pack count for the same
  weight (one 454 g block against four 113 g sticks), and claims the names do
  not make (premium eggs, a lactose-free milk named only "Milk 2%").
  Weighed items (the `_KG` codes, about 2,100 listings) are matched as
  similar items only, by name and price per 100 g, never as the same item and
  never in a basket total. The basket does not suggest a cheaper weighed
  item, because its price per 100 g is the API's and can stay on the regular
  price during a sale the store does not mark; the product page lists them
  with that warning. The weighed rule was checked against the live catalogue
  by reading the groups it would form, not scored, since no weighed pairs are
  labelled yet. Keys are rewritten for every product each night, so a rule
  change reaches the whole catalogue after one run. The basket lives in a
  cookie, so it belongs to one browser.
- **Verdicts rest on days, not months, of history.** Tracking started on
  2026-09-21, so "lowest price recorded" means lowest in that window. The
  product page says how many days it is based on.
- **Unit price is unavailable for 0.12% of products.** 16 are measured in
  metres (foil, plastic wrap), 7 in sheets or packs. They have no mass or
  volume, so they get a NULL rather than a fabricated number.
- **Seven stores, two of them outside Ontario.** Superstore 1516, ingested
  since day one, turned out to be Kenaston in Winnipeg when the store list
  was finally read (`0010`), and Maxi's is in Gatineau. It is why Superstore
  carries Beatrice where the Ontario stores carry Neilson. Both keep running,
  so their history keeps growing, but the site shows the Ontario stores
  (postal codes starting K, L, M, N or P) unless a visitor switches to all of
  them. `0011` added a GTA Superstore, 1033 on Gerry Fitzgerald Drive in
  Toronto: the nearest of all 119 to Vaughan, since none is inside it. The
  two Superstores share a colour on graphs, so with every store shown the
  legend and store lists tell them apart by place. A visitor can enter a
  postal code and a radius to see the stores near it, in any province; that
  is stored in a cookie as the first three characters only. The distance is
  from the middle of the visitor's postal-code area to the middle of the
  store's, so it is good to a few kilometres and the site says "about". The
  areas are looked up from zippopotam.us (`POSTAL_GEOCODER_URL` in
  `web/.env.example` names another), cached, and written as a miss rather
  than guessed when the service is down; a store that cannot be placed is
  shown, not hidden. Store coordinates are not stored: `stores.lat` and
  `lng` exist and are empty, and filling them from `python -m ingest.stores
  discover` would make the store side exact and remove those lookups. More
  stores are a migration and a line in
  `targets.json` each; `python -m ingest.stores` finds and proves the codes.
  Each store adds about 3 minutes to the nightly run. Its timeout is 90
  minutes and a full run must fit in half of it (`test_targets.py`), which
  holds thirteen stores; past that, split the job.
- **Unit prices before 2026-09-24 are reconstructed.** The runs before then
  stored none, or the API's figure on the regular price. `0008` works out
  what today's code would have stored, from the shelf price and package size
  that were stored, and the views read that instead; `unit_price_backfilled`
  marks those rows and `price_spans` still holds what was written. Spans with
  no readable package size keep no unit price.
- **The regular price on unmarked deals is an estimate.** About a fifth of
  Superstore's products are discounted with no `wasPrice`. Since `0007` their
  regular price is rebuilt from the API's unit price into
  `implied_regular_cents`, and search results show it as "usually ~$2.30".
  The API rounds its unit price to the cent per 100 g, so it can be a few
  cents out, and history before 2026-09-24 does not have it.
- **Storage growth is measured over one week, not months.** Storing changes
  only (`0006`) was simulated at 8.7x fewer rows than one row per product per
  night when every product changes weekly. The first real week, 2026-09-25 to
  10-01 with each store's first night left out, wrote 28,016 rows for 238,745
  products seen: 11.7%, or 8.5x fewer rows. Most nights wrote 5.6% to 11.8%,
  and most of that was listings coming and going from search results, not
  prices: on 09-30, 116 shelf prices changed and 2,890 rows were listings new
  or back after a missed night. Thursday, when the weekly flyer turns over,
  wrote 27.7% (9,711 shelf prices, 2,956 sales started, 2,744 ended). The
  database was 65 MB on 10-01 and grew about 1.1 MB a night, which reaches
  Supabase's 500 MB free tier around October 2027. On 10-07, after 17 nights,
  it was 70 MB: about 0.8 MB a night since 10-01, so October 2027 is the
  early end of the estimate. `products` is the larger part (41 MB against
  15 MB of price history on 10-07), since search results bring in about 800
  never-seen listings a night. `db/queries/storage_growth.sql`, also the
  workflow's storage-report task, recomputes all of this.

## Legal

Personal, non-commercial project. Not affiliated with, endorsed by, or
connected to Loblaw Companies Limited or any retailer. It uses an undocumented
internal API, which is against Loblaw's terms of service; requests are rate
limited to roughly 1/second and responses are cached. Sustained 403s or a key
rotation are treated as a stop signal.
