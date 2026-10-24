-- 0019_store_coordinates_again.sql
-- Place the five stores 0013 was meant to place.
--
-- 0013 was never applied to production, and cannot be now: it requires
-- exactly 7 stores placed, and two of its 7 (superstore/1516 and maxi/8711)
-- are gone since 0018. On 2026-10-24 these five had lat and lng NULL in
-- production, so the site placed them at the centre of their postal-code area
-- (web/src/lib/store-scope.ts placeStores), a few kilometres out. The five
-- 0014 added came with their coordinates.
--
-- Same coordinates as 0013, from the same storefront store list.
--
-- Only a store still missing a coordinate is touched, so this is a no-op
-- where 0013 did run (the test schema in test_db_integration.py applies every
-- migration in order): it places all five or none. Either way every code
-- below must name a store, and afterwards no store may be left unplaced.

BEGIN;

DO $$
DECLARE
    found   integer;
    placed  integer;
BEGIN
    WITH v (banner_slug, store_code, lat, lng) AS (
             VALUES
                 ('nofrills',   '3131', 43.84142, -79.48594),
                 ('loblaw',     '1032', 43.87419, -79.28475),
                 ('zehrs',      '0552', 44.08990, -79.13312),
                 ('fortinos',   '1436', 43.71666, -79.44726),
                 ('superstore', '1033', 43.78483, -79.47177)
         ),
         matched AS (
             SELECT s.id, v.lat, v.lng
               FROM v
               JOIN retailers r ON r.banner_slug = v.banner_slug
               JOIN stores s ON s.retailer_id = r.id AND s.store_code = v.store_code
         ),
         updated AS (
             UPDATE stores s
                SET lat = m.lat,
                    lng = m.lng
               FROM matched m
              WHERE s.id = m.id
                AND (s.lat IS NULL OR s.lng IS NULL)
             RETURNING s.id
         )
    SELECT (SELECT count(*) FROM matched), (SELECT count(*) FROM updated)
      INTO found, placed;

    -- A code that matched nothing would leave a store unplaced without a word.
    IF found <> 5 THEN
        RAISE EXCEPTION 'expected to find 5 stores, found %', found;
    END IF;
    IF placed NOT IN (0, 5) THEN
        RAISE EXCEPTION 'expected to place 0 or 5 stores, placed %', placed;
    END IF;
    IF EXISTS (SELECT 1 FROM stores WHERE lat IS NULL OR lng IS NULL) THEN
        RAISE EXCEPTION 'a store still has no coordinates';
    END IF;

    RAISE NOTICE 'placed % stores', placed;
END
$$;

COMMIT;
