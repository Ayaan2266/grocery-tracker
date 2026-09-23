-- 0007_implied_regular_price.sql
-- Store the regular price behind deals the API does not mark as deals.
--
-- The first full unit-price check (2026-09-23) found that on about a fifth of
-- Superstore's products the shelf price is discounted with no wasPrice, while
-- the API's unit price stays on the regular price: Mango Nectar, 960 ml at
-- $1.50, reported $0.24/100 ml, the price of a $2.30 bottle. Nothing else in
-- the response marks these as deals, so until now they were stored as
-- ordinary prices, and "is this really a deal" had no answer for them.
--
-- implied_regular_cents is that unit price times the package size, written
-- by ingest/normalize.py only when there is no wasPrice and the API's figure
-- is meaningfully higher than the shelf price. It is kept apart from
-- was_price_cents on purpose: was_price_cents is what the API declared, this
-- is what we inferred, and mixing the two would make neither trustworthy.
--
-- It is approximate. The API rounds its unit price to the cent per 100 g (or
-- whatever quantity it quotes), so the rebuilt price can be off by half a
-- cent per 100 g of package: about 3 cents on a 540 g loaf.
--
-- Safe to apply before the code that writes it is deployed: the column is
-- nullable, the current writer names its columns, and the views keep every
-- existing column in place and only append this one.

BEGIN;

ALTER TABLE price_spans ADD COLUMN implied_regular_cents INTEGER;

-- The append-only trigger from 0006 compares whole rows as JSON, so this
-- column is protected from UPDATE without touching it.

-- Both views gain the column at the end. CREATE OR REPLACE VIEW keeps the
-- grants but replaces the options, so security_invoker is repeated.

CREATE OR REPLACE VIEW price_observations WITH (security_invoker = true) AS
SELECT s.product_id,
       s.price_cents,
       s.was_price_cents,
       s.unit_price_cents,
       s.comparison_unit,
       s.comparison_quantity,
       s.unit_price_source,
       s.in_stock,
       r.run_on AS observed_on,
       s.implied_regular_cents
  FROM price_spans s
  JOIN products p    ON p.id = s.product_id
  JOIN ingest_runs r ON r.store_id = p.store_id
                    AND r.run_on BETWEEN s.first_observed_on AND s.last_confirmed_on;

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
       o.unit_price_cents,
       o.comparison_unit,
       o.comparison_quantity,
       o.unit_price_source,
       o.in_stock,
       o.implied_regular_cents
  FROM products p
  JOIN stores s    ON s.id = p.store_id
  JOIN retailers r ON r.id = s.retailer_id
 CROSS JOIN LATERAL (
       SELECT *
         FROM price_spans ps
        WHERE ps.product_id = p.id
        ORDER BY ps.first_observed_on DESC
        LIMIT 1
       ) o;

COMMIT;
