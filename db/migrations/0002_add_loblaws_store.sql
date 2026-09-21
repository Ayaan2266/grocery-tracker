-- 0002_add_loblaws_store.sql
-- Adds the third verified store. 1032 (Loblaws) was confirmed live on
-- 2026-09-20 alongside 3131 and 1516 -- see docs/data-sources.md -- but only
-- the first two were seeded, so the loblaw retailer had no store attached and
-- a whole banner was accumulating no history.
--
-- Only verified codes belong here. A guessed storeId returns HTTP 200 with
-- zero results, so a wrong code looks exactly like a working store with
-- nothing in stock.
--
-- Note on ON CONFLICT, since 0001 predates ingest/db.py existing: writes
-- against `products` upsert on (store_id, retailer_sku) because product
-- metadata is mutable -- names and package sizes get re-worded upstream.
-- `price_observations` remains the append-only table, and its conflict clause
-- is DO NOTHING, never DO UPDATE.

INSERT INTO stores (retailer_id, store_code, label)
SELECT id, '1032', 'Loblaws'
  FROM retailers
 WHERE banner_slug = 'loblaw'
ON CONFLICT (retailer_id, store_code) DO NOTHING;
