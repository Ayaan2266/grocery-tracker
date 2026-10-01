-- storage_growth.sql
-- How fast the price history grows, from what the nightly runs actually wrote:
-- products seen against rows written, night by night and over the last seven
-- nights, why the rows were written, and when the database would reach
-- Supabase's 500 MB free tier at that rate.
--
-- Each store's first night is left out everywhere: every product is new that
-- night, so it says nothing about how often prices change. (Superstore 1033's
-- first night, 2026-09-30, wrote 6,808 rows that way.)
--
-- Read-only. The first statement makes the transaction read-only, so this
-- file cannot write even though it runs as the owner:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--        -f db/queries/storage_growth.sql
--
-- Also a manual task of the ingest workflow: Actions -> Nightly ingest ->
-- Run workflow -> task: storage-report.

SET TRANSACTION READ ONLY;

\pset pager off

-- Every query below starts from the same two definitions. A read-only
-- transaction cannot CREATE even a temporary view, so they are repeated.
--   store_nights: one row per store per night, with the rows it wrote.
--   last_week:    the last seven nights, each store's first night left out.

\echo
\echo '== Each night: products seen and rows written (first nights left out)'
WITH store_nights AS (
    SELECT r.store_id, r.run_on, r.products_observed,
           coalesce(w.rows_written, 0) AS rows_written,
           r.run_on = f.first_run AS first_night
      FROM ingest_runs r
      JOIN (SELECT store_id, min(run_on) AS first_run FROM ingest_runs GROUP BY store_id) f
        USING (store_id)
      LEFT JOIN (
          SELECT p.store_id, s.first_observed_on AS run_on, count(*) AS rows_written
            FROM price_spans s JOIN products p ON p.id = s.product_id
           GROUP BY 1, 2
      ) w ON w.store_id = r.store_id AND w.run_on = r.run_on
)
SELECT run_on,
       count(*) FILTER (WHERE NOT first_night)                         AS stores,
       sum(products_observed) FILTER (WHERE NOT first_night)          AS products_seen,
       sum(rows_written) FILTER (WHERE NOT first_night)               AS rows_written,
       round(100.0 * sum(rows_written) FILTER (WHERE NOT first_night)
             / nullif(sum(products_observed) FILTER (WHERE NOT first_night), 0), 1) AS pct_written,
       count(*) FILTER (WHERE first_night)                            AS first_nights_left_out
  FROM store_nights
 GROUP BY run_on
 ORDER BY run_on DESC
 LIMIT 14;

\echo
\echo '== The last seven nights together'
WITH store_nights AS (
    SELECT r.store_id, r.run_on, r.products_observed,
           coalesce(w.rows_written, 0) AS rows_written,
           r.run_on = f.first_run AS first_night
      FROM ingest_runs r
      JOIN (SELECT store_id, min(run_on) AS first_run FROM ingest_runs GROUP BY store_id) f
        USING (store_id)
      LEFT JOIN (
          SELECT p.store_id, s.first_observed_on AS run_on, count(*) AS rows_written
            FROM price_spans s JOIN products p ON p.id = s.product_id
           GROUP BY 1, 2
      ) w ON w.store_id = r.store_id AND w.run_on = r.run_on
),
last_week AS (
    SELECT * FROM store_nights
     WHERE NOT first_night
       AND run_on IN (SELECT DISTINCT run_on FROM ingest_runs ORDER BY run_on DESC LIMIT 7)
)
SELECT min(run_on) AS from_day, max(run_on) AS to_day,
       count(DISTINCT run_on) AS nights,
       sum(products_observed) AS products_seen,
       sum(rows_written) AS rows_written,
       round(100.0 * sum(rows_written) / nullif(sum(products_observed), 0), 1) AS pct_written,
       round(sum(products_observed)::numeric / nullif(sum(rows_written), 0), 1) AS times_fewer_rows
  FROM last_week;

\echo
\echo '== Why the rows were written, last seven nights (a row can count under several)'
WITH store_nights AS (
    SELECT r.store_id, r.run_on, r.products_observed,
           coalesce(w.rows_written, 0) AS rows_written,
           r.run_on = f.first_run AS first_night
      FROM ingest_runs r
      JOIN (SELECT store_id, min(run_on) AS first_run FROM ingest_runs GROUP BY store_id) f
        USING (store_id)
      LEFT JOIN (
          SELECT p.store_id, s.first_observed_on AS run_on, count(*) AS rows_written
            FROM price_spans s JOIN products p ON p.id = s.product_id
           GROUP BY 1, 2
      ) w ON w.store_id = r.store_id AND w.run_on = r.run_on
),
last_week AS (
    SELECT * FROM store_nights
     WHERE NOT first_night
       AND run_on IN (SELECT DISTINCT run_on FROM ingest_runs ORDER BY run_on DESC LIMIT 7)
),
opened AS (
    SELECT s.*, w.run_on
      FROM price_spans s
      JOIN products p ON p.id = s.product_id
      JOIN last_week w ON w.store_id = p.store_id AND w.run_on = s.first_observed_on
)
SELECT o.run_on,
       count(*)                                                                   AS rows_written,
       count(*) FILTER (WHERE prev.price_cents IS NULL)                           AS new_listing,
       count(*) FILTER (WHERE prev.last_confirmed_on < o.run_on - 1)              AS back_after_a_gap,
       count(*) FILTER (WHERE prev.price_cents <> o.price_cents)                  AS shelf_price,
       count(*) FILTER (WHERE prev.was_price_cents IS NULL
                          AND o.was_price_cents IS NOT NULL)                      AS sale_started,
       count(*) FILTER (WHERE prev.was_price_cents IS NOT NULL
                          AND o.was_price_cents IS NULL)                          AS sale_ended,
       count(*) FILTER (WHERE prev.price_cents = o.price_cents
                          AND prev.in_stock <> o.in_stock)                        AS stock_only
  FROM opened o
  LEFT JOIN LATERAL (
      SELECT s.price_cents, s.was_price_cents, s.in_stock, s.last_confirmed_on
        FROM price_spans s
       WHERE s.product_id = o.product_id AND s.first_observed_on < o.first_observed_on
       ORDER BY s.first_observed_on DESC
       LIMIT 1
  ) prev ON true
 GROUP BY o.run_on
 ORDER BY o.run_on DESC;

\echo
\echo '== Storage, and when 500 MB is reached at the last seven nights'' rate'
WITH store_nights AS (
    SELECT r.store_id, r.run_on, r.products_observed,
           coalesce(w.rows_written, 0) AS rows_written,
           r.run_on = f.first_run AS first_night
      FROM ingest_runs r
      JOIN (SELECT store_id, min(run_on) AS first_run FROM ingest_runs GROUP BY store_id) f
        USING (store_id)
      LEFT JOIN (
          SELECT p.store_id, s.first_observed_on AS run_on, count(*) AS rows_written
            FROM price_spans s JOIN products p ON p.id = s.product_id
           GROUP BY 1, 2
      ) w ON w.store_id = r.store_id AND w.run_on = r.run_on
),
last_week AS (
    SELECT * FROM store_nights
     WHERE NOT first_night
       AND run_on IN (SELECT DISTINCT run_on FROM ingest_runs ORDER BY run_on DESC LIMIT 7)
),
sizes AS (
    SELECT pg_database_size(current_database())                 AS database_bytes,
           pg_total_relation_size('price_spans')                AS spans_bytes,
           (SELECT count(*) FROM price_spans)                   AS span_rows,
           pg_total_relation_size('products')                   AS products_bytes,
           (SELECT count(*) FROM products)                      AS product_rows
), week AS (
    SELECT count(DISTINCT run_on) AS nights,
           sum(rows_written)::numeric / nullif(count(DISTINCT run_on), 0) AS rows_per_night
      FROM last_week
), new_products AS (
    SELECT count(*)::numeric / nullif((SELECT nights FROM week), 0) AS per_night
      FROM (SELECT product_id, min(first_observed_on) AS first_seen
              FROM price_spans GROUP BY product_id) f
      JOIN products p ON p.id = f.product_id
      JOIN last_week w ON w.store_id = p.store_id AND w.run_on = f.first_seen
), rate AS (
    SELECT sizes.*, week.rows_per_night, new_products.per_night AS products_per_night,
           -- Indexes included, and the dead rows that moving last_confirmed_on
           -- forward leaves behind until autovacuum, so this is real growth.
           spans_bytes::numeric / nullif(span_rows, 0) * week.rows_per_night
             + products_bytes::numeric / nullif(product_rows, 0) * new_products.per_night
             AS bytes_per_night
      FROM sizes, week, new_products
)
SELECT pg_size_pretty(database_bytes)                                     AS database,
       pg_size_pretty(spans_bytes)                                        AS price_spans,
       span_rows,
       round(rows_per_night)                                              AS span_rows_per_night,
       round(products_per_night)                                          AS new_products_per_night,
       pg_size_pretty(round(bytes_per_night)::bigint)                     AS growth_per_night,
       floor((500 * 1024 * 1024 - database_bytes) / nullif(bytes_per_night, 0))::int AS nights_to_500mb,
       current_date
         + floor((500 * 1024 * 1024 - database_bytes) / nullif(bytes_per_night, 0))::int AS around
  FROM rate;
