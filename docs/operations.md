# Operations

How the nightly run is scheduled, how the site is deployed, and how backups work.

## Nightly schedule

The nightly run is started at 07:10 UTC by Supabase, which sends the workflow
a "Run workflow" request (`db/ops/nightly_dispatch.sql`): GitHub's own schedule
started every run 5 to 8 hours late. That schedule stays as the fallback, and
`--once-per-day` makes whichever run comes second stop before any request. To
re-run a night on purpose, run the workflow with `force` ticked.
The Supabase job was set up on 2026-10-02 and a test dispatch was accepted
(204), so the first on-time night is the 10-03 run. It authenticates with a
fine-grained GitHub token kept in Vault as `github_dispatch_token` (Actions:
read and write, this repository only). The token expires; when it does the
dispatch fails with 401 and nights fall back to GitHub's late schedule, so
replace it with `vault.update_secret` (steps in `db/ops/nightly_dispatch.sql`)
before then. If it is missed anyway, the fallback says so: the schedule passes
`--fallback`, which records a night the on-time start missed and then exits 3,

## Integration tests

stays silent. To check a night, the morning after:

```sql
select status_code, error_msg, created from net._http_response order by created desc limit 5;
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
```

The write-path tests need a real Postgres and skip silently without one. CI
provides it; locally:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export INGEST_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

## Deploying

The site runs on Vercel. The nightly ingest stays on GitHub Actions; Vercel
never holds `DATABASE_URL` or the PCX key.

1. Import the repository in Vercel and set **Root Directory** to `web`. The
   framework is detected as Next.js; the build command is `next build`.
2. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the
   anon or `sb_publishable_` key) for Production and Preview.
   `POSTAL_GEOCODER_URL` is optional (`web/.env.example`), and so is
   `SITE_URL`, needed only once the site has a custom domain.
3. Set the function region as close to the database as Vercel offers. The
   Supabase project is in `ca-central-1` (Montréal), and a page makes two or
   three queries in a row, so each one pays the round trip.
4. Apply any migration the code needs before it deploys: Actions -> Nightly
   ingest -> Run workflow -> task `migrate`. `0012` is an index the product
   page benefits from; nothing breaks without it. `0016` adds the views the
   price-changes page reads; without it that page says price data is
   unavailable and every other page is unaffected. `0023` stores those
   changes in a table the nightly run refills; without it the page works
   them out on every visit, which can run past the API's time limit.

Every push to `main` deploys, and every pull request gets a preview. Previews
read the same database as production, which is safe because the key cannot
write.

Unknown addresses and product ids get a 404 page with search, and anything a
page throws gets an error page with a retry, both in the site's own layout
(`web/src/app/not-found.tsx`, `error.tsx`). A product page shows a placeholder
in its own shape while its queries run (`product/[id]/loading.tsx`).

A link to any page unfurls in Discord, LinkedIn, iMessage and Slack as a card
drawn at build time from the site's mark, art and typeface
(`web/src/app/opengraph-image.tsx`); a product link's card text carries its
latest price and store. `robots.txt` keeps crawlers out of the basket only, and
`sitemap.xml` lists the fixed pages. All three take the site's address from
`SITE_URL`, else Vercel's production domain.

In production the site sends security headers on every response (no framing,
no MIME sniffing, a strict referrer policy), marks its cookies `Secure`, and
keeps the store list, coverage counts and how-it-works status in Next's data
cache for 15 minutes, since they change once a night.

## Backups

Supabase's free plan keeps no backups a project can download, and price
history cannot be fetched again later. Every Sunday at 09:23 UTC the `backup`
job of the ingest workflow dumps the `public` schema with `pg_dump` and keeps it
as a workflow artifact for 90 days, so about thirteen weekly copies exist at any
time. It also runs on demand: Actions -> Nightly ingest -> Run workflow -> task
`backup`.

The dump holds every table, view, policy and trigger the site uses, and only
data the anon key can already read. Vault and cron are left out, so the
dispatch token never lands in an artifact. The job reads the dump back and
fails if the price history or products are missing from it.

To restore, download the artifact and load it into an empty Supabase project
(or any Postgres 17 with roles named `anon` and `authenticated`):

```bash
pg_restore --no-owner -d "$DATABASE_URL" grocery-tracker-YYYY-MM-DD.dump
```

It reports one ignored error, `schema "public" already exists`, which is
expected. Use the session pooler (port 5432) or a direct connection, not the
6543 pooler the nightly run uses.
