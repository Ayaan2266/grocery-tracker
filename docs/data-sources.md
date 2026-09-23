# Data sources

## Loblaw PC Express (PCX)

One endpoint and one key serve every Loblaw banner. The banner is selected by
headers plus the request body, not by hostname.

```
POST https://api.pcexpress.ca/pcx-bff/api/v1/products/search
```

Also exists: `POST /pcx-bff/api/v1/products/type-ahead` (autocomplete).

Confirmed **not** to exist — all return 404: `/api/v1/listing-page`,
`/api/v1/listingPage`, `/api/v1/search`.

Contract verified live on 2026-09-20 against the production API, not inferred
from documentation.

### Why not scrape the storefront

`www.nofrills.ca` is a Next.js app (`pcx-iceberg-prod`) whose search page is
server-rendered, so there is no product XHR on page load — the API only
surfaces on client-side interaction. The storefront also sits behind Akamai Bot
Manager (sensor POSTs to obfuscated paths) plus a Shape-style fingerprinter at
`sp.nofrills.ca/sp/h`. Scraping the HTML is a dead end. `api.pcexpress.ca` is a
separate host with different protection.

### Headers

```
Content-Type:          application/json
Accept:                application/json
Accept-Language:       en
baseSiteId:            nofrills          # swap per banner
Site-Banner:           nofrills          # swap per banner
Business-User-Agent:   PCXWEB
x-apikey:              $PCX_API_KEY
x-loblaw-tenant-id:    ONLINE_GROCERIES
x-channel:             web
x-application-type:    web
```

`x-apikey` is a static public key shipped in the storefront's JavaScript bundle
to every visitor. No login, no OAuth, no rotating token on this endpoint. It is
not a credential. It still lives in `PCX_API_KEY` and never in a committed
file — a hardcoded key in a public repo reads as careless regardless of whether
it is actually secret.

### Request body

```json
{
  "banner": "nofrills",
  "lang": "en",
  "storeId": "3131",
  "term": "2% milk 4l",
  "cartId": "",
  "pagination": { "from": 0, "size": 48 },
  "filters": [],
  "sort": {},
  "date": "20092026",
  "pickupType": "STORE",
  "offerType": "OG"
}
```

### Response fields consumed

Per entry in `results[]`:

| Field | Use |
|---|---|
| `code` | Retailer SKU, e.g. `20188873_EA`. Natural key within a retailer. |
| `name`, `brand`, `packageSize` | Product identity; inputs to matching. |
| `stockStatus` | `"OK"` means in stock. |
| `prices.price.value` | Current price. Stored as integer cents. |
| `prices.wasPrice` | **Non-null only when on sale.** The only sale signal. |
| `prices.comparisonPrices[]` | Already normalized to $/100g or $/100ml. |
| `pagination.totalResults` | Paging. |

`comparisonPrices` being pre-normalized deletes most of the unit-normalization
work originally budgeted for week 1. `normalize.py` is a validation layer over
it, not a parser. The parser only runs as a fallback for products that return
an empty `comparisonPrices`.

### comparisonPrices, verified 2026-09-22

Sampled live across six categories, 315 products, 90 of them on sale:

```json
{"value": 1.56, "unit": "g", "quantity": 100,
 "reasonCode": null, "type": "REGULAR", "expiryDate": null}
```

`unit` is the base unit and `quantity` is a separate multiplier, so this reads
as $1.56 per 100 g. It is not a compound `"100g"` string, and the vocabulary is
the same one `packageSize` uses, so there is one namespace rather than two.

In that sample, three `(unit, quantity)` pairs occurred:

| pair | n |
|---|---|
| `(g, 100)` | 306 |
| `(ml, 100)` | 6 |
| `(ea, 1)` | 3 |

The full nightly run on 2026-09-23 also turned up per 1000 g, per 10 ml and
per 100 ea (sliced turkey at $36.18/kg, for example). `extract_unit_price`
rescales every figure onto per 100 g, per 100 ml or per 1 ea.

**No product had more than one entry**, including the 90 on sale, so the first
entry is taken and there is no selection rule to write.

**`type` is a trap.** It reads `"REGULAR"` even on a discounted item, but the
value tracks the *current* selling price. Triple Cheddar Shredded Cheese at
$4.99 (was $6.00) in a 320 g pack reported $1.56/100 g, and 1.56 x 3.2 = 4.99,
not 6.00. Filtering on `type` to find "the regular price" would silently pair a
sale shelf price with a regular-price unit price on every discounted row.

**Except when there is no `wasPrice`.** The first full-catalogue check
(2026-09-23) found deals whose unit price stays on the regular price: 60 of 288
comparable Superstore products in the stored sample, 21% of Superstore's
products in the nightly count, and about 2% at No Frills and Loblaws:

| product | shelf | API unit price | implies |
|---|---|---|---|
| Mango Nectar, 960 ml | $1.50 | $0.24/100 ml | $2.30 |
| Artesano Original White Bread, 540 g | $2.97 | $0.79/100 g | $4.27 |
| Lemon Lime Soft Drink, 6x710 ml | $3.97 | $0.15/100 ml | $6.39 |

None of them had a `wasPrice`, so nothing else in the response marks them as
discounted. That is why unit prices are derived from the shelf price and the
API's figure is only a fallback. What exactly these deals are (multi-buy,
member pricing, clearance) is not yet known: the fields that would say are
dropped by `extra="ignore"`.

`wasPrice` is the same shape, carrying `type: "WAS"` and `unit: "ea"`. Only
`.value` is consumed.

### Verified cross-banner divergence

Query `"2% milk 4l"`, same key, same endpoint, 2026-09-20:

| Banner | storeId | Result |
|---|---|---|
| nofrills | 3131 (Vaughan) | Neilson 2% 4L — **$6.44** |
| superstore | 1516 | Beatrice 2% 4L — **$5.94** |
| loblaw | 1032 | Neilson 2% 4L — $6.44; Neilson Microfiltered 4L — $7.18 |

Real store-level divergence on identical products. The premise holds.

### Banner slugs

Verified: `nofrills`, `superstore`, `loblaw`.
Unverified (no known-good storeId yet): `zehrs`, `maxi`, `fortinos`, `provigo`,
`independent`, `valumart`, `wholesaleclub`, `atlantic`, `dominion`.

Known-good store codes: `3131` (No Frills Vaughan), `1516` (Superstore),
`1032` (Loblaws).

## Gotchas

1. **`date` is `DDMMYYYY`, not ISO.** The wrong format returns stale or empty
   pricing with a 200 status.
2. **A bad `storeId` returns 200 with `totalResults: 0`, not an error.** Guessed
   IDs for Zehrs, Maxi and Fortinos all silently returned empty. This is why
   `LoblawClient.verify_store` runs canary terms before every store's ingest —
   without it, months of empty nightly runs look like success.
3. **Never scrape the storefront HTML.** Akamai wins.
4. **Rate limit to ~1 req/sec and cache hard.** Personal, non-commercial use
   only. This is undocumented internal API usage and is against Loblaw's terms.
   Key rotation or sustained 403s is a stop signal, not a problem to route
   around with proxies.
5. **A rotated or wrong key returns 401, not 403.** Verified on 2026-09-21:
   the body is `{"error": "invalid_client", "error_description": "The client
   credentials provided were invalid, the request is unauthorized."}`. Since
   the key is a static value shipped in the storefront bundle, 401 is the
   likelier of the two stop signals — it is what a rotation looks like.
   `LoblawClient` treats 401 and 403 alike: never retried, abandon the run,
   exit 2. The message names which remedy applies.

## Open items

- [x] **Does a cold server-side request work?** Yes. Answered 2026-09-21 by the
      nightly job itself rather than by inference: three stores verified on
      canary terms and 8.5 minutes of continuous fetching from a GitHub Actions
      runner, with no cookies, no `Origin` header and a datacenter IP. Zero
      403s across two consecutive nights.
- [ ] **Real store list.** Open the storefront's store picker with a `fetch`
      interceptor installed and capture the endpoint it calls. That seeds
      `stores` with postal codes and coordinates instead of hand-found codes.
