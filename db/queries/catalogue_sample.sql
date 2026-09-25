-- catalogue_sample.sql
-- What cross-store matching has to work with: how names, brands and sizes are
-- written, how much the stores share by SKU, and what the nearest same-size
-- product at another store looks like for items only one store carries.
--
-- Read-only. The first statement makes the transaction read-only, so this
-- file cannot write even though it runs as the owner:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--        -f db/queries/catalogue_sample.sql

SET TRANSACTION READ ONLY;

\pset pager off
\pset format unaligned
\pset fieldsep ' | '
\pset footer off
\pset null '-'

\echo
\echo '== 1. products per store, and how many of them share a SKU with another store'
WITH sku_stores AS (
    SELECT retailer_sku, count(DISTINCT store_id) AS stores
      FROM products
     GROUP BY retailer_sku
)
SELECT r.banner_slug,
       count(*)                                          AS products,
       count(*) FILTER (WHERE ss.stores = 1)             AS only_here,
       count(*) FILTER (WHERE ss.stores = 2)             AS at_two,
       count(*) FILTER (WHERE ss.stores >= 3)            AS at_three,
       count(*) FILTER (WHERE coalesce(p.brand, '') = '') AS no_brand,
       count(*) FILTER (WHERE p.size_value IS NULL)      AS no_size
  FROM products p
  JOIN stores s     ON s.id = p.store_id
  JOIN retailers r  ON r.id = s.retailer_id
  JOIN sku_stores ss USING (retailer_sku)
 GROUP BY r.banner_slug
 ORDER BY r.banner_slug;

\echo
\echo '== 2. SKU suffixes'
SELECT coalesce(substring(retailer_sku FROM '_[A-Z]+$'), '(none)') AS suffix, count(*)
  FROM products
 GROUP BY 1
 ORDER BY 2 DESC
 LIMIT 10;

\echo
\echo '== 3. top 70 brands, by store'
SELECT coalesce(p.brand, '(null)') AS brand,
       count(*) AS total,
       count(*) FILTER (WHERE r.banner_slug = 'nofrills')   AS nofrills,
       count(*) FILTER (WHERE r.banner_slug = 'superstore') AS superstore,
       count(*) FILTER (WHERE r.banner_slug = 'loblaw')     AS loblaw
  FROM products p
  JOIN stores s    ON s.id = p.store_id
  JOIN retailers r ON r.id = s.retailer_id
 GROUP BY 1
 ORDER BY 2 DESC
 LIMIT 70;

\echo
\echo '== 4. brands written more than one way'
SELECT lower(regexp_replace(brand, '[^[:alnum:]]', '', 'g')) AS folded,
       string_agg(DISTINCT brand, ' / ') AS spellings,
       count(*)
  FROM products
 WHERE brand IS NOT NULL
 GROUP BY 1
HAVING count(DISTINCT brand) > 1
 ORDER BY 3 DESC
 LIMIT 30;

\echo
\echo '== 5. how often the name repeats the brand, or carries a size or pack count'
SELECT count(*)                                                              AS products,
       count(*) FILTER (WHERE brand IS NOT NULL)                             AS branded,
       count(*) FILTER (WHERE brand IS NOT NULL
                          AND strpos(lower(raw_name), lower(brand)) > 0)     AS name_has_brand,
       count(*) FILTER (WHERE raw_name ~* '\d+(\.\d+)?\s*(g|kg|ml|l)\M')     AS name_has_size,
       count(*) FILTER (WHERE raw_name ~* '\d+\s*(pk|pack|ct|count|x)\M')    AS name_has_count,
       count(*) FILTER (WHERE raw_name ~ ',')                                AS name_has_comma
  FROM products;

\echo
\echo '== 6. the 150 most common name tokens'
SELECT string_agg(token || ' ' || n, ', ' ORDER BY n DESC) AS tokens
  FROM (
        SELECT token, count(*) AS n
          FROM products, regexp_split_to_table(lower(raw_name), '[^[:alnum:]%]+') AS token
         WHERE token <> ''
         GROUP BY token
         ORDER BY n DESC
         LIMIT 150
       ) t;

\echo
\echo '== 7. package_size strings that did not parse'
SELECT package_size, count(*)
  FROM products
 WHERE size_value IS NULL
 GROUP BY 1
 ORDER BY 2 DESC
 LIMIT 15;

\echo
\echo '== 8. a fixed pseudo-random sample of 90 products'
SELECT r.banner_slug, p.retailer_sku, p.brand, p.raw_name, p.package_size
  FROM products p
  JOIN stores s    ON s.id = p.store_id
  JOIN retailers r ON r.id = s.retailer_id
 ORDER BY md5(p.retailer_sku || r.banner_slug)
 LIMIT 90;

\echo
\echo '== 9. same brand, name and size under different SKUs (identity the SKU misses?)'
WITH groups AS (
    SELECT lower(coalesce(p.brand, '')) AS brand, lower(p.raw_name) AS name,
           p.size_value, p.size_unit,
           count(DISTINCT p.retailer_sku) AS skus,
           string_agg(DISTINCT p.retailer_sku || '@' || r.banner_slug, ' ') AS listings
      FROM products p
      JOIN stores s    ON s.id = p.store_id
      JOIN retailers r ON r.id = s.retailer_id
     GROUP BY 1, 2, 3, 4
    HAVING count(DISTINCT p.retailer_sku) > 1
)
SELECT (SELECT count(*) FROM groups) AS groups_total, brand, name, size_value, size_unit, listings
  FROM groups
 ORDER BY skus DESC, name
 LIMIT 40;

\echo
\echo '== 10. store-only products, and the most similar same-size product at each other store'
WITH sku_stores AS (
    SELECT retailer_sku FROM products GROUP BY retailer_sku HAVING count(DISTINCT store_id) = 1
),
only_here AS (
    SELECT p.*, r.banner_slug
      FROM products p
      JOIN sku_stores USING (retailer_sku)
      JOIN stores s    ON s.id = p.store_id
      JOIN retailers r ON r.id = s.retailer_id
     WHERE p.size_value IS NOT NULL
     ORDER BY md5(p.retailer_sku)
     LIMIT 120
)
SELECT e.banner_slug AS here, e.brand, e.raw_name, e.package_size,
       o.banner_slug AS there, o.brand AS their_brand, o.raw_name AS their_name,
       o.package_size AS their_size, round(o.sim::numeric, 2) AS sim
  FROM only_here e
 CROSS JOIN LATERAL (
       SELECT r2.banner_slug, p2.brand, p2.raw_name, p2.package_size,
              similarity(p2.raw_name, e.raw_name) AS sim
         FROM products p2
         JOIN stores s2    ON s2.id = p2.store_id
         JOIN retailers r2 ON r2.id = s2.retailer_id
        WHERE p2.store_id <> e.store_id
          AND p2.size_unit = e.size_unit
          AND p2.size_value BETWEEN e.size_value * 0.95 AND e.size_value * 1.05
          AND p2.raw_name % e.raw_name
        ORDER BY sim DESC
        LIMIT 1
       ) o
 ORDER BY e.raw_name;

\echo
\echo '== 11. every listing of a few staples, by size'
SELECT staple, banner_slug, retailer_sku, brand, raw_name, package_size,
       to_char(price_cents / 100.0, 'FM990.00') AS price
  FROM (
        SELECT CASE
                   WHEN raw_name ~* '\m2\s*%' AND raw_name ~* '\mmilk\M'      THEN '2% milk'
                   WHEN raw_name ~* '^(salted |unsalted )?butter\M'
                     OR raw_name ~* '\mbutter,? (salted|unsalted)'           THEN 'butter'
                   WHEN raw_name ~* '\mlarge\M.*\meggs?\M'                   THEN 'large eggs'
                   WHEN raw_name ~* '\mketchup\M'                            THEN 'ketchup'
                   WHEN raw_name ~* '\mpeanut butter\M'                      THEN 'peanut butter'
                   WHEN raw_name ~* '\mspaghetti\M'                          THEN 'spaghetti'
                   WHEN raw_name ~* '\mdiced tomatoes\M'                     THEN 'diced tomatoes'
                   WHEN raw_name ~* '\morange juice\M'                       THEN 'orange juice'
               END AS staple,
               l.*
          FROM product_latest_price l
       ) t
 WHERE staple IS NOT NULL
 ORDER BY staple, size_unit, size_value, banner_slug, raw_name
 LIMIT 320;
