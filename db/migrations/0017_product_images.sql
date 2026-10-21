-- 0017_product_images.sql
-- A photo of each product, as a link to the store's own image.
--
-- The search API sends imageAssets with every result: up to six photos, each
-- at 120, 250, 400, 800 and 1200 px, all on digital.loblaws.ca. The nightly
-- run keeps the first photo's 400 px link (ingest/normalize.py
-- extract_image_url), and the site swaps the size in the file name for the
-- one it needs (web/src/lib/images.ts). Only the link is stored, never the
-- image: about 100 bytes a product, against the 500 MB the free plan allows.
--
-- It lives on products with the name and package size, refreshed with them
-- every night, because a photo is identity, not history.
--
-- Apply this before deploying the code that writes it. Preflight checks for
-- the column and stops the night before any API request if it is missing.
--
-- Products the nightly run has not seen since this was applied keep a NULL
-- link, and the site shows them without a photo, as before.

BEGIN;

ALTER TABLE products ADD COLUMN image_url TEXT;

-- Both views gain image_url at the end. Everything else is 0009's and 0016's
-- definitions. security_invoker is repeated: CREATE OR REPLACE VIEW replaces
-- the options.
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
       p.substitute_key,
       p.image_url
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

CREATE OR REPLACE VIEW price_changes WITH (security_invoker = true) AS
WITH runs AS (
    SELECT store_id,
           run_on,
           lag(run_on) OVER (PARTITION BY store_id ORDER BY run_on) AS previous_run_on,
           row_number() OVER (PARTITION BY store_id ORDER BY run_on DESC) AS recency
      FROM ingest_runs
)
SELECT p.id                                   AS product_id,
       p.retailer_sku,
       p.raw_name,
       p.brand,
       p.package_size,
       s.id                                   AS store_id,
       s.store_code,
       s.label                                AS store_label,
       r.banner_slug,
       r.name                                 AS retailer_name,
       lr.run_on                              AS changed_on,
       lr.previous_run_on                     AS previous_run_on,
       prev.price_cents                       AS previous_price_cents,
       cur.price_cents,
       cur.price_cents - prev.price_cents     AS change_cents,
       round(100.0 * (cur.price_cents - prev.price_cents) / prev.price_cents, 1) AS change_percent,
       prev.was_price_cents                   AS previous_was_price_cents,
       cur.was_price_cents,
       cur.implied_regular_cents,
       p.image_url
  FROM runs lr
  JOIN products p        ON p.store_id = lr.store_id
  JOIN price_spans cur   ON cur.product_id = p.id
                        AND cur.first_observed_on = lr.run_on
  JOIN price_spans prev  ON prev.product_id = p.id
                        AND prev.last_confirmed_on = lr.previous_run_on
                        AND prev.first_observed_on < cur.first_observed_on
  JOIN stores s          ON s.id = p.store_id
  JOIN retailers r       ON r.id = s.retailer_id
 WHERE lr.recency = 1
   AND cur.in_stock
   AND cur.price_cents IS NOT NULL
   AND prev.price_cents > 0
   AND cur.price_cents <> prev.price_cents;

COMMIT;
