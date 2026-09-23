-- unit_price_mismatches.sql
-- Why the API's unit price and the one the package size implies disagree.
-- Read-only; paste into the Supabase SQL Editor.
--
-- Mirrors ingest.normalize.unit_price_disagreement exactly: the product's
-- latest price, API-sourced, comparison unit equal to the package's unit, and
-- more than 1 cent and 2% apart. Each mismatch is put in the first bucket
-- whose signature it fits:
--
--   quantity_basis  the API quotes per a different quantity (e.g. per kg,
--                   stored as 1000 g) than the per-100 g the check assumes
--   rounding        within 2 cents; small unit prices round coarsely
--   regular_price   on sale, and the API figure matches the pre-sale price
--   multipack       "12x355 ml": the API figure fits one item, not the pack
--   other           none of the above
--
-- ratio = API unit price / derived unit price.

WITH latest AS (
    SELECT DISTINCT ON (ps.product_id)
           ps.*, p.raw_name, p.package_size, p.size_value, p.size_unit, s.store_code
      FROM price_spans ps
      JOIN products p ON p.id = ps.product_id
      JOIN stores s   ON s.id = p.store_id
     ORDER BY ps.product_id, ps.first_observed_on DESC
),
comparable AS (
    SELECT *,
           CASE size_unit WHEN 'ea' THEN 1 ELSE 100 END AS per,
           round(price_cents * CASE size_unit WHEN 'ea' THEN 1 ELSE 100 END / size_value)
               AS derived_cents
      FROM latest
     WHERE unit_price_source = 'api'
       AND unit_price_cents IS NOT NULL
       AND size_value > 0
       AND comparison_unit = size_unit
),
mismatched AS (
    SELECT *,
           round(unit_price_cents::numeric / derived_cents, 3) AS ratio,
           CASE
               WHEN comparison_quantity <> per THEN 'quantity_basis'
               WHEN abs(unit_price_cents - derived_cents) <= 2 THEN 'rounding'
               WHEN was_price_cents IS NOT NULL
                AND abs(unit_price_cents - round(was_price_cents * per / size_value)) <= 1
                   THEN 'regular_price'
               WHEN package_size ~* '^\s*\d+(\.\d+)?\s*[x×]' THEN 'multipack'
               ELSE 'other'
           END AS cause
      FROM comparable
     WHERE derived_cents > 0
       AND abs(unit_price_cents - derived_cents) > 1
       AND abs(unit_price_cents - derived_cents)::numeric
           / greatest(unit_price_cents, derived_cents, 1) > 0.02
)
SELECT c.store_code,
       coalesce(m.cause, '(none)')                                   AS cause,
       count(m.*)                                                    AS mismatches,
       (SELECT count(*) FROM comparable x WHERE x.store_code = c.store_code) AS comparable_rows,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY m.ratio)          AS median_ratio,
       array_to_string((array_agg(
           m.raw_name || ' | ' || m.package_size
           || ' | $' || to_char(m.price_cents / 100.0, 'FM990.00')
           || coalesce(' (was $' || to_char(m.was_price_cents / 100.0, 'FM990.00') || ')', '')
           || ' | api ' || m.unit_price_cents || 'c/' || m.comparison_quantity || m.comparison_unit
           || ' vs ' || m.derived_cents || 'c/' || m.per || m.size_unit
           ORDER BY m.product_id))[1:3], ' ;; ')                     AS examples
  FROM (SELECT DISTINCT store_code FROM comparable) c
  LEFT JOIN mismatched m ON m.store_code = c.store_code
 GROUP BY c.store_code, m.cause
 ORDER BY c.store_code, mismatches DESC;
