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
