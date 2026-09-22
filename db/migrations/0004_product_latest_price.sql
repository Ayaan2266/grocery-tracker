-- 0004_product_latest_price.sql
-- The view every listing page reads.
--
-- "One row per product, carrying its most recent observation" is the shape the
-- search results and the basket view both want, and expressing it in PostgREST
-- is awkward: an embedded resource cannot be ordered and limited per parent.
-- DISTINCT ON does it in one pass, and idx_observations_product_date already
-- provides exactly the ordering it needs.
--
-- security_invoker = true matters. A view runs with its owner's permissions by
-- default, and the owner here is the same role that bypasses RLS, so without
-- this the view would be a hole straight through the policies added in 0003.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE VIEW product_latest_price WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.id)
    p.id                AS product_id,
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
    o.observed_on,
    o.price_cents,
    o.was_price_cents,
    o.unit_price_cents,
    o.comparison_unit,
    o.comparison_quantity,
    o.unit_price_source,
    o.in_stock
  FROM products p
  JOIN stores s             ON s.id = p.store_id
  JOIN retailers r          ON r.id = s.retailer_id
  JOIN price_observations o ON o.product_id = p.id
 ORDER BY p.id, o.observed_on DESC;

-- Search is ILIKE '%term%', which no btree index can serve. A trigram index
-- can, and product names are short enough that it stays small.
CREATE INDEX idx_products_raw_name_trgm ON products USING gin (raw_name gin_trgm_ops);

-- One row, five numbers, for the landing page. Cheap enough to query on every
-- render and it means the front page says something true about the data rather
-- than describing an intention.
CREATE VIEW ingest_coverage WITH (security_invoker = true) AS
SELECT (SELECT count(*) FROM products)                              AS products,
       (SELECT count(*) FROM price_observations)                    AS observations,
       (SELECT count(DISTINCT observed_on) FROM price_observations) AS days,
       (SELECT min(observed_on) FROM price_observations)            AS first_day,
       (SELECT max(observed_on) FROM price_observations)            AS last_day;

GRANT SELECT ON product_latest_price, ingest_coverage TO anon, authenticated;
