# Data notes and known limits

How unit prices are worked out, and an honest list of what does not work yet.

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

## Known limits


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
- **Ten stores, all in Ontario.** Superstore 1516, ingested since day one,
  turned out to be Kenaston in Winnipeg when the store list was finally read
  (`0010`), and Maxi 8711 was in Gatineau. Nobody using the site could shop
  at either, so `0018` stopped checking both and deleted their history: about
  17% of the database and 16% of its nightly growth. `0011` added a GTA
  Superstore, 1033 on Gerry Fitzgerald Drive in Toronto: the nearest of all
  119 to Vaughan, since none is inside it.
  `0014` added five more in Toronto: Loblaws on Carlton Street and two No
  Frills, all within 1.2 km of Toronto Metropolitan University, and the Don
  Mills and Weston Road Superstores. A banner's stores share its colour on
  graphs and are told apart by line and dot (solid, dashed, dotted,
  dash-dot), and the graph's store chips and store lists name the place. A visitor can enter a
  postal code and a radius to see the stores near it, in any province; that
  is stored in a cookie as the first three characters only. The distance is
  from the middle of the visitor's postal-code area to the store itself
  (`0013` stores each store's coordinates, from the storefront's own store
  list), so it is good to a few kilometres and the site says "about". The
  visitor's area is looked up from zippopotam.us (`POSTAL_GEOCODER_URL` in
  `web/.env.example` names another), cached, and written as a miss rather
  than guessed when the service is down. A store without coordinates would
  be placed by its own postal-code area the same way, and one that cannot be
  placed is shown, not hidden. More stores are a migration and a line in
  `targets.json` each; `python -m ingest.stores` finds and proves the codes,
  and prints the coordinates the migration sets.
  Each store adds about 3 minutes to the nightly run, so ten take about
  31. Its timeout is 90 minutes and a full run must fit in half of it
  (`test_targets.py`), which holds thirteen stores; past that, split the job.
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
