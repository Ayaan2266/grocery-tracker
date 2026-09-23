-- 0006_store_price_changes_only.sql
-- Store a row when a price changes, not every night it stays the same.
--
-- Why: one row per product per day is ~17,500 rows and ~2.9 MB a night, which
-- fills Supabase's 500 MB free tier in about five months, at which point the
-- project goes read-only and inserts fail. Grocery prices move weekly at
-- most, so most of those rows repeat the night before.
--
-- The storage is now run-length encoded:
--
--   price_spans   one row per unbroken stretch of identical values:
--                 first_observed_on .. last_confirmed_on. A night that sees
--                 the same values moves last_confirmed_on forward instead of
--                 inserting.
--   ingest_runs   one row per (store, day) that was actually ingested.
--
-- The catch with storing only changes is telling "unchanged" apart from "we
-- didn't look". ingest_runs is what answers it, together with one rule in
-- ingest/db.py: a span is only extended if it was confirmed on the store's
-- previous run. So:
--
--   - a product missing from a run that happened starts a new span when it
--     comes back, and the night it was missing is not reported as observed;
--   - a night where the whole store failed has no ingest_runs row, so a span
--     can bridge it without claiming it was observed that night.
--
-- The logical model does not change. price_observations is now a view that
-- rebuilds exactly one row per product per observed day from those two
-- tables (spans x runs), and product_latest_price and ingest_coverage keep
-- their columns, so nothing that reads them has to change.
--
-- Append-only, restated: no price is ever rewritten. The one UPDATE the
-- nightly write issues moves last_confirmed_on forward, and a trigger below
-- makes that the only UPDATE Postgres will accept on this table, from any
-- role, including the owner that ingestion connects as. That is a stronger
-- guarantee than before, where "never UPDATE price_observations" was a
-- convention checked by grep.
--
-- Existing history is converted, then checked row for row against the
-- original before anything is renamed. If the rebuilt view differs from the
-- original table by one row, the migration raises and the whole transaction
-- rolls back. The original table is kept, renamed and closed to the API, as
-- price_observations_daily_v1. Drop it once you have looked at the result.
--
-- Wrapped in its own transaction because the backfill, the rename and the
-- check have to land together or not at all. `psql -f` otherwise commits
-- statement by statement.

BEGIN;

-- ---------------------------------------------------------------------------
-- New storage
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_runs (
    store_id          INTEGER NOT NULL REFERENCES stores (id),
    run_on            DATE NOT NULL,
    -- Products observed at this store on this day. The landing page's
    -- observation count sums this rather than expanding every span.
    products_observed INTEGER NOT NULL DEFAULT 0,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (store_id, run_on)
);

CREATE TABLE price_spans (
    product_id          INTEGER NOT NULL REFERENCES products (id),
    first_observed_on   DATE NOT NULL,
    last_confirmed_on   DATE NOT NULL,
    price_cents         INTEGER,
    -- From the API's wasPrice. Non-null means the item was on sale.
    was_price_cents     INTEGER,
    unit_price_cents    INTEGER,
    -- Stays here rather than on products: it can differ between nights (it
    -- is NULL whenever unit_price_source is 'none'), and products is
    -- overwritten on every run, which would re-scale historical unit prices.
    comparison_unit     TEXT,
    comparison_quantity NUMERIC,
    unit_price_source   TEXT NOT NULL DEFAULT 'none',
    in_stock            BOOLEAN NOT NULL DEFAULT TRUE,
    -- No surrogate id. (product_id, first_observed_on) is the natural key, and
    -- a BIGSERIAL with its own index cost another 30 bytes a row in 0001.
    -- It also serves "one product's history" and "this product's latest span".
    PRIMARY KEY (product_id, first_observed_on),
    CHECK (last_confirmed_on >= first_observed_on)
);

-- ---------------------------------------------------------------------------
-- Backfill from the daily table
-- ---------------------------------------------------------------------------

-- Every store-day with observations was a run. min(observed_at) is when it
-- was written: NOW() is fixed per transaction and each store commits as one.
INSERT INTO ingest_runs (store_id, run_on, products_observed, recorded_at)
SELECT p.store_id, o.observed_on, count(*), min(o.observed_at)
  FROM price_observations o
  JOIN products p ON p.id = o.product_id
 GROUP BY p.store_id, o.observed_on;

-- Gaps and islands. A new span starts on a product's first observation, when
-- any value differs from its previous observation, or when its previous
-- observation was not on the store's previous run. That is the same rule
-- ingest/db.py applies nightly, so converted history and new history are
-- indistinguishable.
INSERT INTO price_spans (
    product_id, first_observed_on, last_confirmed_on, price_cents, was_price_cents,
    unit_price_cents, comparison_unit, comparison_quantity, unit_price_source, in_stock
)
WITH runs AS (
    SELECT store_id, run_on,
           lag(run_on) OVER (PARTITION BY store_id ORDER BY run_on) AS previous_run_on
      FROM ingest_runs
),
daily AS (
    SELECT o.product_id, o.observed_on, o.price_cents, o.was_price_cents,
           o.unit_price_cents, o.comparison_unit, o.comparison_quantity,
           o.unit_price_source, o.in_stock,
           r.previous_run_on,
           lag(o.observed_on) OVER w AS previous_observed_on,
           lag(ROW(o.price_cents, o.was_price_cents, o.unit_price_cents,
                   o.comparison_unit, o.comparison_quantity, o.unit_price_source,
                   o.in_stock)) OVER w
               IS DISTINCT FROM
           ROW(o.price_cents, o.was_price_cents, o.unit_price_cents,
               o.comparison_unit, o.comparison_quantity, o.unit_price_source,
               o.in_stock) AS values_changed
      FROM price_observations o
      JOIN products p ON p.id = o.product_id
      JOIN runs r     ON r.store_id = p.store_id AND r.run_on = o.observed_on
    WINDOW w AS (PARTITION BY o.product_id ORDER BY o.observed_on)
),
islands AS (
    SELECT *,
           sum(CASE WHEN previous_observed_on IS NULL
                      OR previous_observed_on <> previous_run_on
                      OR values_changed
                    THEN 1 ELSE 0 END)
               OVER (PARTITION BY product_id ORDER BY observed_on) AS island
      FROM daily
)
-- Every row in an island carries the same values, so grouping by them is
-- only a way of carrying them through.
SELECT product_id, min(observed_on), max(observed_on), price_cents, was_price_cents,
       unit_price_cents, comparison_unit, comparison_quantity, unit_price_source, in_stock
  FROM islands
 GROUP BY product_id, island, price_cents, was_price_cents, unit_price_cents,
          comparison_unit, comparison_quantity, unit_price_source, in_stock;

-- ---------------------------------------------------------------------------
-- Swap the table for a view with the same name and the same rows
-- ---------------------------------------------------------------------------

ALTER TABLE price_observations RENAME TO price_observations_daily_v1;

-- One row per product per observed day, exactly what the table used to hold
-- minus the surrogate id and the insert timestamp (now ingest_runs.recorded_at).
-- Filtered by product_id, which is how a history chart reads it, this is a
-- primary-key range scan plus a handful of run rows.
CREATE VIEW price_observations WITH (security_invoker = true) AS
SELECT s.product_id,
       s.price_cents,
       s.was_price_cents,
       s.unit_price_cents,
       s.comparison_unit,
       s.comparison_quantity,
       s.unit_price_source,
       s.in_stock,
       r.run_on AS observed_on
  FROM price_spans s
  JOIN products p    ON p.id = s.product_id
  JOIN ingest_runs r ON r.store_id = p.store_id
                    AND r.run_on BETWEEN s.first_observed_on AND s.last_confirmed_on;

-- The proof. EXCEPT ALL in both directions: every original row is rebuilt,
-- with identical values, and nothing is rebuilt that was not there.
DO $$
DECLARE
    missing BIGINT;
    extra   BIGINT;
    daily   BIGINT;
    spans   BIGINT;
BEGIN
    SELECT count(*) INTO missing FROM (
        SELECT product_id, price_cents, was_price_cents, unit_price_cents, comparison_unit,
               comparison_quantity, unit_price_source, in_stock, observed_on
          FROM price_observations_daily_v1
        EXCEPT ALL
        SELECT * FROM price_observations
    ) d;

    SELECT count(*) INTO extra FROM (
        SELECT * FROM price_observations
        EXCEPT ALL
        SELECT product_id, price_cents, was_price_cents, unit_price_cents, comparison_unit,
               comparison_quantity, unit_price_source, in_stock, observed_on
          FROM price_observations_daily_v1
    ) d;

    IF missing <> 0 OR extra <> 0 THEN
        RAISE EXCEPTION
            'price_spans does not rebuild the daily table: % row(s) missing, % extra. '
            'Nothing has been changed.', missing, extra;
    END IF;

    SELECT count(*) INTO daily FROM price_observations_daily_v1;
    SELECT count(*) INTO spans FROM price_spans;
    RAISE NOTICE '% daily observation(s) stored as % span(s), rebuilt exactly', daily, spans;
END
$$;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by Postgres rather than by convention
-- ---------------------------------------------------------------------------

-- Compares the whole row minus last_confirmed_on, so a column added later is
-- protected without anyone remembering to list it here. The empty search_path
-- is what Supabase's security advisor asks of every function; everything this
-- one calls lives in pg_catalog.
CREATE FUNCTION price_spans_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'price_spans is append-only: % is not allowed', TG_OP;
    END IF;

    IF to_jsonb(NEW) - 'last_confirmed_on' IS DISTINCT FROM to_jsonb(OLD) - 'last_confirmed_on' THEN
        RAISE EXCEPTION
            'price_spans is append-only: only last_confirmed_on may change '
            '(product_id=%, first_observed_on=%)', OLD.product_id, OLD.first_observed_on;
    END IF;

    IF NEW.last_confirmed_on < OLD.last_confirmed_on THEN
        RAISE EXCEPTION
            'price_spans is append-only: last_confirmed_on only moves forward '
            '(product_id=%, % -> %)', OLD.product_id, OLD.last_confirmed_on, NEW.last_confirmed_on;
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER price_spans_append_only
    BEFORE UPDATE OR DELETE ON price_spans
    FOR EACH ROW EXECUTE FUNCTION price_spans_guard();

-- Row triggers do not fire on TRUNCATE.
CREATE TRIGGER price_spans_no_truncate
    BEFORE TRUNCATE ON price_spans
    FOR EACH STATEMENT EXECUTE FUNCTION price_spans_guard();

-- ---------------------------------------------------------------------------
-- The views the frontend reads, repointed at the new storage
-- ---------------------------------------------------------------------------

-- Same columns, same order, so web/src/lib/queries.ts is untouched. The
-- WITH clause must be repeated: CREATE OR REPLACE VIEW replaces the options
-- too, and dropping security_invoker would open a hole through RLS.
--
-- LATERAL rather than 0004's DISTINCT ON. A filter on the view (the search
-- box's ILIKE on raw_name) cannot be pushed beneath DISTINCT ON, so every
-- search was reading every observation ever stored. Here it narrows products
-- first, through the trigram index, and then reads one span per match.
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
       o.in_stock
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

-- Counts come from ingest_runs: expanding every span into days to count them
-- would get slower every night, and this is queried on every page render.
CREATE OR REPLACE VIEW ingest_coverage WITH (security_invoker = true) AS
SELECT (SELECT count(*) FROM products)                             AS products,
       (SELECT coalesce(sum(products_observed), 0) FROM ingest_runs) AS observations,
       (SELECT count(DISTINCT run_on) FROM ingest_runs)            AS days,
       (SELECT min(run_on) FROM ingest_runs)                       AS first_day,
       (SELECT max(run_on) FROM ingest_runs)                       AS last_day;

-- ---------------------------------------------------------------------------
-- Row level security and privileges, the same model as 0003
-- ---------------------------------------------------------------------------

ALTER TABLE price_spans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON price_spans
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "public read" ON ingest_runs
    FOR SELECT TO anon, authenticated USING (true);

-- Supabase grants new tables and views to anon by default, so REVOKE first.
REVOKE ALL ON price_spans, ingest_runs, price_observations FROM anon, authenticated;
GRANT SELECT ON price_spans, ingest_runs, price_observations TO anon, authenticated;

-- The archive is not part of the public API.
REVOKE ALL ON price_observations_daily_v1 FROM anon, authenticated;

COMMIT;
