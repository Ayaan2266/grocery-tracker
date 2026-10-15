-- 0016_price_changes.sql
-- What changed overnight: every shelf price that moved on a store's latest
-- run, for the site's price-changes page (web/src/app/changes).
--
-- A change is read straight off price_spans, which already opens a new row
-- whenever any value changes (0006). For each store's latest run:
--
--   cur   the span that opened on that run, and
--   prev  the span the same product was confirmed in on the store's
--         previous run.
--
-- Requiring prev to be confirmed on the previous run, not merely earlier, is
-- what makes this "since last night". A listing that went missing for a few
-- nights and came back at a new price is left out: a jump across a gap is
-- not something a shopper saw happen overnight, and a returning listing is
-- most of what a normal night writes (README, "Storage growth"). A span that
-- opened for another reason (stock, unit price, a sale label) with the same
-- shelf price is left out too.
--
-- Only in-stock listings count; a price on an item the store cannot sell is
-- not a deal. Both prices must be known and the old one positive, so the
-- percentage is defined.
--
-- price_change_counts is the per-store tally the page's tabs and store chips
-- show, so they do not have to fetch every row to count them.
--
-- Both views run as the invoker (0004), so anon reads them through the same
-- RLS policies as the tables underneath, and neither can be written through.

BEGIN;

CREATE VIEW price_changes WITH (security_invoker = true) AS
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
       cur.implied_regular_cents
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

CREATE VIEW price_change_counts WITH (security_invoker = true) AS
SELECT store_id,
       changed_on,
       count(*) FILTER (WHERE change_cents < 0) AS drops,
       count(*) FILTER (WHERE change_cents > 0) AS rises
  FROM price_changes
 GROUP BY store_id, changed_on;

GRANT SELECT ON price_changes, price_change_counts TO anon, authenticated;

COMMIT;
