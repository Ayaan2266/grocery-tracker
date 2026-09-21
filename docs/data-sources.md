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

- [ ] **Does a cold server-side request work?** All verification calls ran from
      inside the browser, carrying its cookies and `Origin` header. A request
      from GitHub Actions carries neither. Test with cURL from a clean terminal
      before trusting the nightly job. 200 → clean pipeline. 403 → a cookie
      warm-up step is needed.
- [ ] **Real store list.** Open the storefront's store picker with a `fetch`
      interceptor installed and capture the endpoint it calls. That seeds
      `stores` with postal codes and coordinates instead of hand-found codes.
