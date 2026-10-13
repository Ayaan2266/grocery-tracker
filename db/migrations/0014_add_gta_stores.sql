-- 0014_add_gta_stores.sql
-- Five more Toronto stores: three a short walk from Toronto Metropolitan
-- University, and two Superstores to the east and west of the city.
--
-- Until now the nearest tracked store to downtown Toronto was Fortinos on
-- Lawrence, about 9 km north-west. These put a Loblaws and two No Frills
-- within 1.2 km of campus, beside the Loblaws, No Frills and Superstore
-- already tracked further out.
--
-- On 2026-10-13 `python -m ingest.stores discover loblaw nofrills superstore
-- --near 43.6577,-79.3788` (the probe-stores task, run 49) listed every store
-- of the three banners by distance from TMU and canary-searched the three
-- nearest of each. All nine returned products. Five are added:
--
--   loblaw/1007      Loblaws Carlton Street (Maple Leaf Gardens)  0.5 km  131 canary hits
--   nofrills/6791    No Frills Shuter                             0.4 km   74
--   nofrills/3643    No Frills M5A 4T9                            1.2 km  119
--   superstore/1077  Superstore Don Mills                         8.0 km  124
--   superstore/2800  Superstore Weston Road                      13.7 km  128
--
-- Also verified and left for later: loblaw/1079 Lower Jarvis (125) and
-- loblaw/1000 Queen Street (132), nofrills/7047 (83). Superstore 1077 and
-- 2800 were first verified on 2026-09-29 (0011).
--
-- The storefront names nofrills/3643 only "Rocco's NOFRILLS Toronto", so its
-- label carries its postal code until its street is confirmed.
--
-- Coordinates are the storefront's own, as discover printed them (0013).

BEGIN;

DO $$
DECLARE
    added integer;
BEGIN
    -- In this order, so the ids are: the site tells a banner's stores apart
    -- by id (web/src/lib/stores.ts storeMarks).
    INSERT INTO stores (retailer_id, store_code, label, postal_code, lat, lng)
    SELECT r.id, v.store_code, v.label, v.postal_code, v.lat, v.lng
      FROM (VALUES
               (1, 'loblaw',     '1007', 'Loblaws - Toronto Carlton Street',               'M5B 1L1', 43.66196, -79.37960),
               (2, 'nofrills',   '6791', 'No Frills - Toronto Shuter',                     'M5B 0E8', 43.65481, -79.37537),
               (3, 'nofrills',   '3643', 'No Frills - Toronto M5A 4T9',                    'M5A 4T9', 43.65142, -79.36595),
               (4, 'superstore', '1077', 'Real Canadian Superstore - Toronto Don Mills',   'M3C 1V4', 43.72270, -79.33751),
               (5, 'superstore', '2800', 'Real Canadian Superstore - Toronto Weston Road', 'M9N 2A7', 43.70931, -79.53386)
           ) AS v (ord, banner_slug, store_code, label, postal_code, lat, lng)
      JOIN retailers r ON r.banner_slug = v.banner_slug
     ORDER BY v.ord
    ON CONFLICT (retailer_id, store_code) DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT;
    -- A banner slug that matched nothing would drop its store without a word,
    -- and the nightly preflight would then stop the whole night for it.
    IF added <> 5 THEN
        RAISE EXCEPTION 'expected to add 5 stores, added %', added;
    END IF;
END
$$;

COMMIT;
