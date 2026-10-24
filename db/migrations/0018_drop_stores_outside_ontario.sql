-- 0018_drop_stores_outside_ontario.sql
-- Stop tracking the two stores outside Ontario, and delete what they hold.
--
--   superstore/1516  Real Canadian Superstore Kenaston, Winnipeg MB  (since 0001)
--   maxi/8711        Maxi Aylmer Vanier, Gatineau QC                 (since 0010)
--
-- Every visitor shops in Ontario and the site hid both by default (0011), so
-- they were a sixth of the nightly requests and of the database for prices
-- nobody could use. Measured on 2026-10-24, before this ran:
--
--                       Winnipeg   Gatineau   share of the table
--   products               9,150      6,969   17% of 95,067
--   price_spans           39,424     20,249   23% of 261,152
--   unit_price_backfill    7,718          0   35% of 22,361
--   spans, last 7 nights   5,826      3,540   18% of 50,920
--
-- About 21.5 MB of the 119 MB database, and about 0.22 of the 1.37 MB the
-- database grew each night.
--
-- This deletes price history, which db/migrations/README.md otherwise
-- forbids. The triggers from 0006 (price_spans) and 0008
-- (unit_price_backfill) refuse a DELETE from every role, the owner included,
-- so each is switched off for its one DELETE and back on straight after, all
-- inside this transaction; if anything fails, the rollback takes the switch
-- with it. Only rows of these two stores' products are touched.
-- The weekly backup taken before this ran still holds them.
--
-- Apply it after the change that takes both out of ingest/targets.json is
-- merged: preflight stops the whole night on a target with no store row.
--
-- DELETE leaves the space for autovacuum to reuse, so the database stops
-- growing until new rows have filled it. To shrink it at once instead, run
-- VACUUM FULL products, price_spans, unit_price_backfill; on its own (it
-- cannot run inside this transaction).

BEGIN;

DO $$
DECLARE
    dropped_ids   integer[];
    backfill_rows integer;
    span_rows     integer;
    product_rows  integer;
    run_rows      integer;
    store_rows    integer;
BEGIN
    SELECT array_agg(s.id) INTO dropped_ids
      FROM stores s JOIN retailers r ON r.id = s.retailer_id
     WHERE (r.banner_slug, s.store_code) IN (('superstore', '1516'), ('maxi', '8711'));
    IF coalesce(cardinality(dropped_ids), 0) <> 2 THEN
        RAISE EXCEPTION 'expected to find 2 stores outside Ontario, found %', coalesce(cardinality(dropped_ids), 0);
    END IF;

    ALTER TABLE unit_price_backfill DISABLE TRIGGER unit_price_backfill_frozen;
    DELETE FROM unit_price_backfill b
     USING products p
     WHERE p.id = b.product_id AND p.store_id = ANY (dropped_ids);
    GET DIAGNOSTICS backfill_rows = ROW_COUNT;
    ALTER TABLE unit_price_backfill ENABLE TRIGGER unit_price_backfill_frozen;

    ALTER TABLE price_spans DISABLE TRIGGER price_spans_append_only;
    DELETE FROM price_spans ps
     USING products p
     WHERE p.id = ps.product_id AND p.store_id = ANY (dropped_ids);
    GET DIAGNOSTICS span_rows = ROW_COUNT;
    ALTER TABLE price_spans ENABLE TRIGGER price_spans_append_only;

    DELETE FROM products WHERE store_id = ANY (dropped_ids);
    GET DIAGNOSTICS product_rows = ROW_COUNT;

    DELETE FROM ingest_runs WHERE store_id = ANY (dropped_ids);
    GET DIAGNOSTICS run_rows = ROW_COUNT;

    DELETE FROM stores WHERE id = ANY (dropped_ids);
    GET DIAGNOSTICS store_rows = ROW_COUNT;

    -- Maxi had no other store. Superstore keeps its four in Toronto.
    DELETE FROM retailers r
     WHERE r.banner_slug = 'maxi'
       AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.retailer_id = r.id);

    IF EXISTS (SELECT 1 FROM stores WHERE postal_code IS NULL OR postal_code !~* '^[KLMNP]') THEN
        RAISE EXCEPTION 'a store outside Ontario is still tracked';
    END IF;

    RAISE NOTICE 'deleted % stores, % products, % price spans, % unit price backfill rows, % nightly runs',
        store_rows, product_rows, span_rows, backfill_rows, run_rows;
END
$$;

COMMIT;
