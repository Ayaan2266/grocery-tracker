-- 0005_drop_redundant_observation_index.sql
-- Drops idx_observations_product_date. It indexes exactly the columns that
-- 0001's UNIQUE (product_id, observed_on) already indexes, so every nightly
-- insert was paying to maintain the same btree twice.
--
-- Measured on 122,500 synthetic rows shaped like a real night (17,500 products
-- x 7 days) on Postgres 16: 165 bytes per observation in total, of which this
-- index was 25.7 -- about 15% of the table's growth, for nothing.
--
-- What changes for readers:
--   - One product's history, newest first (product_id = $1 ORDER BY
--     observed_on DESC) reads the unique index and sorts that product's rows.
--   - product_latest_price, whose 0004 comment points at this index, uses the
--     unique index plus an incremental sort on observed_on DESC. Same result,
--     one fewer index.
--
-- IF EXISTS so the migration is safe to re-run.

DROP INDEX IF EXISTS idx_observations_product_date;
