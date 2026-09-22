# Migrations

Plain numbered SQL, applied in order. No migration framework: four tables do
not justify Alembic, and a reviewer can read the schema in one file.

Apply:

```bash
psql "$DATABASE_URL" -f db/migrations/0001_init.sql
```

Rules:

- Never edit an applied migration. Add a new one.
- Never write an `UPDATE` or `DELETE` against `price_observations`.
- Never add an `INSERT`, `UPDATE` or `DELETE` policy for `anon`. That key ships
  to every browser, so a write policy hands the price history to anyone who
  opens devtools. `0003` grants `SELECT` and nothing else, and
  `ingest/tests/test_db_integration.py` fails if that changes.
