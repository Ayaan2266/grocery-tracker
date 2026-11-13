-- 0023_price_changes_table.sql
-- The price-changes page reads a table, filled once a night, instead of
-- working the night's changes out on every visit.
--
-- price_changes (0016) joined every product to its spans each time it was
-- read: 84,788 products and about 413,000 buffer reads to return 40 rows,
-- 530 ms with everything in memory. The page asks for it four times at once
-- (the per-store counts, a page of drops, and one row each way for the
-- headline), and on the night of 2026-11-13 all four were cancelled by the
-- API role's statement timeout, so the page said price data was unavailable.
--
-- The answer only changes when a night is written, so it is now stored:
--
--   price_changes_live   the 0016 view under a new name: the definition of a
--                        change, still read straight off price_spans. Closed
--                        to the API, so the slow query cannot be reached
--                        from outside.
--   price_change_rows    what that view returned after the last night.
--                        About 9,000 rows on an ordinary night.
--   refresh_price_changes()
--                        empties the table and fills it from the view, in the
--                        caller's transaction. The nightly run calls it once,
--                        after every store is written (ingest/db.py).
--   price_changes,       the names the site reads, with the same columns as
--   price_change_counts  before, now over the table.
--
-- Nothing here touches price_spans: the table is a copy that can be thrown
-- away and rebuilt from history at any time by calling the function.
--
-- Safe to apply before or after the code that calls the function: without the
-- code the table is filled once, below, and goes stale after the next night;
-- without the migration the nightly run logs that the function is missing and
-- carries on. Apply it first.

BEGIN;

DROP VIEW price_change_counts;
ALTER VIEW price_changes RENAME TO price_changes_live;
REVOKE ALL ON price_changes_live FROM anon, authenticated;

CREATE TABLE price_change_rows AS
SELECT * FROM price_changes_live WITH NO DATA;

-- A product belongs to one store and is listed for that store's latest run
-- only, so it appears at most once.
ALTER TABLE price_change_rows ADD PRIMARY KEY (product_id);
CREATE INDEX idx_price_change_rows_day_store ON price_change_rows (changed_on, store_id);

ALTER TABLE price_change_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read" ON price_change_rows
    FOR SELECT TO anon, authenticated USING (true);

-- SET search_path FROM CURRENT for the reason given in 0020: it pins the
-- function to the schema it was created in.
CREATE FUNCTION refresh_price_changes() RETURNS integer
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
    written integer;
BEGIN
    DELETE FROM price_change_rows;
    INSERT INTO price_change_rows SELECT * FROM price_changes_live;
    GET DIAGNOSTICS written = ROW_COUNT;
    RETURN written;
END
$$;

-- Only the role that writes the night may rebuild the table.
REVOKE ALL ON FUNCTION refresh_price_changes() FROM PUBLIC, anon, authenticated;

CREATE VIEW price_changes WITH (security_invoker = true) AS
SELECT * FROM price_change_rows;

CREATE VIEW price_change_counts WITH (security_invoker = true) AS
SELECT store_id,
       changed_on,
       count(*) FILTER (WHERE change_cents < 0) AS drops,
       count(*) FILTER (WHERE change_cents > 0) AS rises
  FROM price_changes
 GROUP BY store_id, changed_on;

GRANT SELECT ON price_change_rows, price_changes, price_change_counts TO anon, authenticated;

SELECT refresh_price_changes() AS price_changes_stored;

COMMIT;
