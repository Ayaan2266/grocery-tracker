-- 0009_product_match_keys.sql
-- Cross-store matching keys, written onto products by the nightly run.
--
-- identity_key    brand + name words + exact package. The same product under
--                 another store's code: No Name 100% Pure Canola Oil 946 ml is
--                 20088990_EA at No Frills and Loblaws, 21594669_EA at
--                 Superstore.
-- substitute_key  name words + pack count + size to three significant
--                 figures, any brand. Similar products, never the same one:
--                 Neilson 2% Milk 4 l and Beatrice Partly Skimmed Milk 2% 4 l.
--
-- Computed by ingest/match.py from raw_name, brand and package_size, so they
-- live on products with the rest of the mutable metadata and are refreshed
-- with it every night. Measured against hand-labelled pairs in
-- ingest/tests/test_match_quality.py.
--
-- Apply this before deploying the code that writes them. Preflight checks for
-- the columns and stops the night before any API request if they are missing.
--
-- Products the nightly run has not seen since this was applied keep NULL keys,
-- which match nothing. The frontend then falls back to the shared product
-- code, exactly as before.

BEGIN;

ALTER TABLE products
    ADD COLUMN identity_key   TEXT,
    ADD COLUMN substitute_key TEXT;

-- Partial: most lookups are by a key some listing holds, and about 4% of
-- products (weighed items, unreadable sizes) never get one.
CREATE INDEX idx_products_identity_key ON products (identity_key)
    WHERE identity_key IS NOT NULL;
CREATE INDEX idx_products_substitute_key ON products (substitute_key)
    WHERE substitute_key IS NOT NULL;

-- The view gains both keys at the end. Everything else is 0008's definition.
-- security_invoker is repeated: CREATE OR REPLACE VIEW replaces the options.
CREATE OR REPLACE VIEW product_latest_price WITH (security_invoker = true) AS
SELECT p.id                AS product_id,
       p.retailer_sku,
       p.raw_name,
       p.brand,
       p.package_size,
       p.size_value,
       p.size_unit,
       s.id                AS store_id,
       s.store_code,
       s.label             AS store_label,
       r.banner_slug,
       r.name              AS retailer_name,
       o.last_confirmed_on AS observed_on,
       o.price_cents,
       o.was_price_cents,
       coalesce(b.unit_price_cents, o.unit_price_cents)       AS unit_price_cents,
       coalesce(b.comparison_unit, o.comparison_unit)         AS comparison_unit,
       coalesce(b.comparison_quantity, o.comparison_quantity) AS comparison_quantity,
       coalesce(b.unit_price_source, o.unit_price_source)     AS unit_price_source,
       o.in_stock,
       o.implied_regular_cents,
       b.product_id IS NOT NULL                               AS unit_price_backfilled,
       p.identity_key,
       p.substitute_key
  FROM products p
  JOIN stores s    ON s.id = p.store_id
  JOIN retailers r ON r.id = s.retailer_id
 CROSS JOIN LATERAL (
       SELECT *
         FROM price_spans ps
        WHERE ps.product_id = p.id
        ORDER BY ps.first_observed_on DESC
        LIMIT 1
       ) o
  LEFT JOIN unit_price_backfill b ON b.product_id = o.product_id
                                 AND b.first_observed_on = o.first_observed_on;

COMMIT;
