-- 0013_store_coordinates.sql
-- Where each store is, for "stores near me".
--
-- stores.lat and lng have existed since 0001 and were never filled, so the
-- site placed every store at the centre of its postal-code area, looked up
-- from zippopotam.us: good to a few kilometres, and a lookup per area the
-- first time anyone asked for stores near them. With these, the store side of
-- every distance is exact; only the visitor's own area is still looked up.
--
-- From the storefront's own store list, as printed by
-- `python -m ingest.stores discover nofrills loblaw zehrs fortinos maxi --checks 0`
-- (the probe-stores task, 2026-10-12, five requests and no searches) and the
-- 2026-09-29 run for Superstore quoted in 0011. Every postal code it gave
-- matches the one already stored.
--
-- A store migration from here on sets lat and lng with the rest of the row;
-- test_db_integration.py fails for any store without them.

BEGIN;

DO $$
DECLARE
    updated integer;
BEGIN
    UPDATE stores s
       SET lat = v.lat,
           lng = v.lng
      FROM (VALUES
               ('nofrills',   '3131', 43.84142, -79.48594),
               ('superstore', '1516', 49.85644, -97.20371),
               ('loblaw',     '1032', 43.87419, -79.28475),
               ('zehrs',      '0552', 44.08990, -79.13312),
               ('fortinos',   '1436', 43.71666, -79.44726),
               ('maxi',       '8711', 45.41703, -75.80866),
               ('superstore', '1033', 43.78483, -79.47177)
           ) AS v (banner_slug, store_code, lat, lng)
      JOIN retailers r ON r.banner_slug = v.banner_slug
     WHERE s.retailer_id = r.id
       AND s.store_code = v.store_code;
    GET DIAGNOSTICS updated = ROW_COUNT;
    -- A code that matched nothing would leave a store unplaced without a word.
    IF updated <> 7 THEN
        RAISE EXCEPTION 'expected to place 7 stores, placed %', updated;
    END IF;
END
$$;

COMMIT;
