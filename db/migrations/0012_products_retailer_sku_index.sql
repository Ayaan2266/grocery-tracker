-- 0012_products_retailer_sku_index.sql
-- An index for looking a product code up across every store.
--
-- The product page finds the same item at other stores by its product code
-- (getSameItemCandidates in web/src/lib/queries.ts:
-- `retailer_sku IN (...)` with no store). The only index holding the code is
-- 0001's UNIQUE (store_id, retailer_sku), which leads with the store, so
-- Postgres 17 reads all of it to find a code: on 2026-10-06, with 53,996
-- products, one lookup read 416 index pages, 18 ms warm and 545 ms the first
-- time. That grows with the catalogue, by about 800 listings a night. On its
-- own column the lookup is a few pages per code.
--
-- Nothing depends on it, so it can be applied before or after the code that
-- ships with it. Building it takes well under a second and holds off writes
-- to products for that long; the nightly run waits rather than fails.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_products_retailer_sku ON products (retailer_sku);

COMMIT;
