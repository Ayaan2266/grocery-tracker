-- 0011_add_superstore_gerry_fitzgerald.sql
-- A Superstore in the GTA, next to the other Ontario stores.
--
-- The one Superstore ingested since day one, 1516, is Kenaston in Winnipeg
-- (0010). It keeps running, so its history is not wasted, and the site stops
-- showing it by default: web/src/lib/stores.ts scopes the site to Ontario by
-- postal code.
--
-- On 2026-09-29 `python -m ingest.stores discover superstore --near
-- 43.8361,-79.5083` (the probe-stores task of the ingest workflow) listed all
-- 119 Superstores by distance from Vaughan and canary-searched the five
-- nearest. All five returned products. None is inside Vaughan itself; the
-- nearest is on Gerry Fitzgerald Drive, just south of Steeles:
--
--   superstore/1033  Gerry Fitzgerald, Toronto  M3J 3N4   6.4 km  153 canary hits
--   superstore/2800  Weston Road, Toronto       M9N 2A7  14.4 km  157
--   superstore/1077  Don Mills, Toronto         M3C 1V4  18.6 km  156
--   superstore/2809  Brimley Road, Toronto      M1P 0A3  20.7 km  159
--   superstore/1030  Bayview Avenue, Aurora     L4G 7Y3  21.2 km  146
--
-- 1033 is added. The other four are verified candidates for more GTA stores.

BEGIN;

INSERT INTO stores (retailer_id, store_code, label, postal_code)
SELECT r.id, '1033', 'Real Canadian Superstore - Toronto Gerry Fitzgerald', 'M3J 3N4'
  FROM retailers r
 WHERE r.banner_slug = 'superstore'
ON CONFLICT (retailer_id, store_code) DO NOTHING;

COMMIT;
