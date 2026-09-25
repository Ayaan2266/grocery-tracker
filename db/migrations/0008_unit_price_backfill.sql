-- 0008_unit_price_backfill.sql
-- Unit prices for the history written before 2026-09-24, corrected without
-- rewriting a stored price.
--
-- Two groups of spans were written by code that no longer runs:
--
--   'none'  Every run before 12:43 UTC on 2026-09-23 used a stub that never
--           produced a unit price. Those spans have none.
--   'api'   The run at 12:43 UTC on 2026-09-23 took the API's comparisonPrices
--           first. That figure stays on the regular price on deals with no
--           wasPrice (Mango Nectar, 960 ml at $1.50, came back as a $2.30
--           bottle), and is quoted per 1000 g or per 10 ml as often as per
--           100 g, so these unit prices sit on mixed bases. Same-day re-runs
--           leave the first write standing, which is why only 808 rows carry it.
--
-- From 2026-09-24 a unit price is the shelf price divided by the package size,
-- with the API's figure rescaled onto per 100 g / 100 ml / 1 ea only when the
-- size does not parse. This migration works out what that code would have
-- stored for the older spans, stores it once in unit_price_backfill, and has
-- price_observations and product_latest_price read it in place of the stored
-- value. price_spans is not touched: its trigger would refuse, and it should.
--
-- Computed now and frozen, not computed by the views. The package size lives
-- on products, which the nightly run overwrites; a view deriving history from
-- it would silently re-scale these unit prices the day a size is re-worded,
-- which is the reason comparison_unit lives on the span (0006).
--
-- The package size is parsed here in SQL, not read from products.size_value:
-- about 950 products were last seen by the stub-era runs, whose parser was also
-- a stub, and have a NULL size_value next to a perfectly readable
-- package_size. A second parser is exactly what normalize.py warns against,
-- so this one is checked against the first: before anything is written, it
-- must agree with every size the Python parser has stored, or the migration
-- raises and nothing changes.

BEGIN;

-- ---------------------------------------------------------------------------
-- The packageSize grammar from ingest/normalize.py: "500 g", "1.89 l",
-- "12x355.0 ml". Five units, folded onto grams, millilitres and each.
-- ---------------------------------------------------------------------------

CREATE TEMPORARY TABLE package_sizes ON COMMIT DROP AS
WITH matched AS (
    SELECT p.id AS product_id,
           regexp_match(
               p.package_size,
               '^\s*(?:(\d+(?:\.\d+)?)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*([a-z]+)\s*$',
               'i'
           ) AS m
      FROM products p
     WHERE p.package_size IS NOT NULL
),
parts AS (
    SELECT product_id,
           coalesce(m[1]::numeric, 1) AS pack_count,
           m[2]::numeric              AS size,
           lower(m[3])                AS unit
      FROM matched
     WHERE m IS NOT NULL
)
SELECT product_id,
       pack_count * size * CASE unit WHEN 'kg' THEN 1000 WHEN 'l' THEN 1000 ELSE 1 END AS total,
       CASE unit WHEN 'kg' THEN 'g' WHEN 'l' THEN 'ml' ELSE unit END AS unit
  FROM parts
 WHERE unit IN ('g', 'kg', 'ml', 'l', 'ea')
   AND size > 0
   AND pack_count > 0;

-- The proof that the two parsers agree, on every product Python has parsed.
DO $$
DECLARE
    disagreements BIGINT;
    example       TEXT;
BEGIN
    SELECT count(*), min(p.package_size)
      INTO disagreements, example
      FROM products p
      LEFT JOIN package_sizes k ON k.product_id = p.id
     WHERE p.size_value IS NOT NULL
       AND (k.total IS DISTINCT FROM p.size_value OR k.unit IS DISTINCT FROM p.size_unit);

    IF disagreements > 0 THEN
        RAISE EXCEPTION
            'the SQL package-size parser disagrees with ingest/normalize.py on % product(s), '
            'e.g. %L. Nothing has been changed.', disagreements, example;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The corrected values, one row per span that needed one
-- ---------------------------------------------------------------------------

CREATE TABLE unit_price_backfill (
    product_id          INTEGER NOT NULL,
    first_observed_on   DATE NOT NULL,
    unit_price_cents    INTEGER NOT NULL,
    comparison_unit     TEXT NOT NULL,
    comparison_quantity NUMERIC NOT NULL,
    -- The route today's code would have taken: 'derived' from the shelf price
    -- and package size, or 'api' when only the API's figure was usable.
    unit_price_source   TEXT NOT NULL CHECK (unit_price_source IN ('derived', 'api')),
    -- The key of the span it corrects. Deliberately not a foreign key: one
    -- would make TRUNCATE price_spans fail on the reference before 0006's
    -- trigger could refuse it, and that trigger is the guarantee worth testing.
    PRIMARY KEY (product_id, first_observed_on)
);

-- Per 100 g, per 100 ml, per 1 ea: CANONICAL_QUANTITY in normalize.py.
-- round() on numeric rounds half away from zero, which for these
-- non-negative amounts is the half-up rounding dollars_to_cents applies.
INSERT INTO unit_price_backfill (
    product_id, first_observed_on, unit_price_cents, comparison_unit,
    comparison_quantity, unit_price_source
)
SELECT s.product_id,
       s.first_observed_on,
       CASE WHEN k.total IS NOT NULL
            THEN round(s.price_cents * (CASE k.unit WHEN 'ea' THEN 1 ELSE 100 END) / k.total)
            ELSE round(s.unit_price_cents
                       * (CASE s.comparison_unit WHEN 'ea' THEN 1 ELSE 100 END)
                       / s.comparison_quantity)
       END,
       coalesce(k.unit, s.comparison_unit),
       CASE coalesce(k.unit, s.comparison_unit) WHEN 'ea' THEN 1 ELSE 100 END,
       CASE WHEN k.total IS NOT NULL THEN 'derived' ELSE 'api' END
  FROM price_spans s
  LEFT JOIN package_sizes k ON k.product_id = s.product_id
 WHERE s.first_observed_on < DATE '2026-09-24'
   AND s.unit_price_source IN ('none', 'api')
   AND s.price_cents IS NOT NULL
   AND (k.total IS NOT NULL
        OR (s.unit_price_source = 'api'
            AND s.unit_price_cents IS NOT NULL
            AND s.comparison_unit IN ('g', 'ml', 'ea')
            AND s.comparison_quantity > 0));

DO $$
DECLARE
    derived BIGINT;
    api     BIGINT;
    left_as_none BIGINT;
BEGIN
    SELECT count(*) FILTER (WHERE unit_price_source = 'derived'),
           count(*) FILTER (WHERE unit_price_source = 'api')
      INTO derived, api
      FROM unit_price_backfill;

    SELECT count(*) INTO left_as_none
      FROM price_spans s
     WHERE s.first_observed_on < DATE '2026-09-24'
       AND s.unit_price_source IN ('none', 'api')
       AND NOT EXISTS (SELECT 1 FROM unit_price_backfill b
                        WHERE b.product_id = s.product_id
                          AND b.first_observed_on = s.first_observed_on);

    RAISE NOTICE
        '% span(s) given a unit price from the shelf price, % rescaled from the API''s, '
        '% left without one (no readable package size)', derived, api, left_as_none;
END
$$;

-- ---------------------------------------------------------------------------
-- Written once, here. The same rule as price_spans: nothing rewrites it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION unit_price_backfill_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'unit_price_backfill is written once by 0008: % is not allowed', TG_OP;
END
$$;

CREATE TRIGGER unit_price_backfill_frozen
    BEFORE UPDATE OR DELETE ON unit_price_backfill
    FOR EACH ROW EXECUTE FUNCTION unit_price_backfill_guard();

CREATE TRIGGER unit_price_backfill_no_truncate
    BEFORE TRUNCATE ON unit_price_backfill
    FOR EACH STATEMENT EXECUTE FUNCTION unit_price_backfill_guard();

-- ---------------------------------------------------------------------------
-- The views read the correction where there is one. Same columns in the same
-- order, plus unit_price_backfilled at the end, so a reader can always tell
-- a stored unit price from a corrected one. security_invoker is repeated:
-- CREATE OR REPLACE VIEW replaces the options along with the query.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW price_observations WITH (security_invoker = true) AS
SELECT s.product_id,
       s.price_cents,
       s.was_price_cents,
       coalesce(b.unit_price_cents, s.unit_price_cents)       AS unit_price_cents,
       coalesce(b.comparison_unit, s.comparison_unit)         AS comparison_unit,
       coalesce(b.comparison_quantity, s.comparison_quantity) AS comparison_quantity,
       coalesce(b.unit_price_source, s.unit_price_source)     AS unit_price_source,
       s.in_stock,
       r.run_on AS observed_on,
       s.implied_regular_cents,
       b.product_id IS NOT NULL                               AS unit_price_backfilled
  FROM price_spans s
  JOIN products p    ON p.id = s.product_id
  JOIN ingest_runs r ON r.store_id = p.store_id
                    AND r.run_on BETWEEN s.first_observed_on AND s.last_confirmed_on
  LEFT JOIN unit_price_backfill b ON b.product_id = s.product_id
                                 AND b.first_observed_on = s.first_observed_on;

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
       b.product_id IS NOT NULL                               AS unit_price_backfilled
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

-- ---------------------------------------------------------------------------
-- Row level security and privileges, the same model as 0003 and 0006
-- ---------------------------------------------------------------------------

ALTER TABLE unit_price_backfill ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON unit_price_backfill
    FOR SELECT TO anon, authenticated USING (true);

REVOKE ALL ON unit_price_backfill FROM anon, authenticated;
GRANT SELECT ON unit_price_backfill TO anon, authenticated;

COMMIT;
