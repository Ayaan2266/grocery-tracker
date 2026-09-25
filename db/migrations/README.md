# Migrations

Plain numbered SQL, applied in order. No migration framework: a handful of
tables do not justify Alembic, and a reviewer can read the schema in a few
files.

Apply each one you have not applied yet, in order, stopping on the first
error:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0006_store_price_changes_only.sql
```

`0006` converts the existing daily history and checks the result row for row
before it renames anything. It runs in its own transaction, so if the check
fails nothing changes. It prints how many daily rows became how many spans. The
original table is kept as `price_observations_daily_v1` and closed to the API.
Drop it once you have compared the two:

```sql
DROP TABLE price_observations_daily_v1;
```

`0008`, `0009` and `0010` go in before the code that uses them is merged: the
nightly run writes the columns `0009` adds, and ingests the stores `0010` adds.
Preflight checks both and stops the night before any API request if either is
missing. `0008` prints how many unit prices it filled in, and refuses to
commit if its package-size parser disagrees with `ingest/normalize.py`.

```bash
for f in 0008 0009 0010; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/${f}_*.sql
done
```

Rules:

- Never edit an applied migration. Add a new one.
- Never rewrite a price. `price_spans` accepts exactly one kind of `UPDATE`,
  moving `last_confirmed_on` forward. The trigger from `0006` refuses every
  other `UPDATE`, plus `DELETE` and `TRUNCATE`, from every role including the
  owner. `ingest/tests/test_db.py` fails if the code issues anything else.
- Never add an `INSERT`, `UPDATE` or `DELETE` policy for `anon`. That key ships
  to every browser, so a write policy hands the price history to anyone who
  opens devtools. `0003` and `0006` grant `SELECT` and nothing else, and
  `ingest/tests/test_db_integration.py` fails if that changes.

## Storage budget

Supabase's free plan caps the database at 500 MB, and a project over the cap
goes read-only, so the nightly insert starts failing. Check where it stands:

```sql
SELECT pg_size_pretty(pg_database_size(current_database())) AS database,
       pg_size_pretty(pg_total_relation_size('price_spans'))  AS price_spans,
       (SELECT count(*) FROM price_spans)                      AS span_rows,
       (SELECT observations FROM ingest_coverage)              AS observations;
```

`observations / span_rows` is the real compression ratio. Measure again a
week apart and divide the difference by 7 to get growth per night.
