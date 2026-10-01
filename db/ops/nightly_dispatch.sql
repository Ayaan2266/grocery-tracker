-- nightly_dispatch.sql
-- Starts the nightly ingest on time.
--
-- GitHub treats a workflow's schedule as a request, not a start time: every
-- scheduled run from 2026-09-25 to 2026-10-01 asked for 07:10 UTC and started
-- 5 to 8 hours late, and GitHub may drop one entirely. A workflow_dispatch, the
-- "Run workflow" button, starts within seconds. So Supabase sends one at 07:10
-- UTC (03:10 Toronto time in summer, 02:10 in winter) with pg_cron and pg_net.
--
-- GitHub's own schedule stays in .github/workflows/ingest.yml as the fallback.
-- The workflow passes --once-per-day, so whichever run comes second stops
-- before a single API request, and a night this job fails to start still runs,
-- late, as before.
--
-- Not a numbered migration: pg_cron and pg_net are Supabase extensions that
-- CI's plain Postgres does not have, and this is how the project is run rather
-- than what its schema is. Run it once in the Supabase SQL editor. Re-running it
-- is safe: cron.schedule with an existing job name replaces that job.
--
-- Before running it, store a GitHub token in Vault under the name the job reads:
--
--   select vault.create_secret('<token>', 'github_dispatch_token',
--                              'Starts the nightly ingest workflow');
--
-- The token: a fine-grained personal access token (GitHub -> Settings ->
-- Developer settings -> Fine-grained tokens) with access to this repository
-- only and one permission, Actions: Read and write. When it expires the job's
-- requests fail with 401 and the nights carry on late, from GitHub's schedule,
-- until a new token replaces it:
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'github_dispatch_token'), '<token>');
--
-- Check it worked, the morning after (204 means GitHub accepted the request):
--
--   select status_code, error_msg, created from net._http_response
--    order by created desc limit 5;
--   select status, return_message, start_time from cron.job_run_details
--    order by start_time desc limit 5;
--
-- To stop it: select cron.unschedule('nightly-ingest-dispatch');

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists pg_net;

select cron.schedule(
    'nightly-ingest-dispatch',
    '10 7 * * *',
    $$
    select net.http_post(
        url := 'https://api.github.com/repos/Ayaan2266/grocery-tracker/actions/workflows/ingest.yml/dispatches',
        body := '{"ref": "main", "inputs": {"task": "ingest"}}'::jsonb,
        headers := jsonb_build_object(
            'Accept', 'application/vnd.github+json',
            'Authorization', 'Bearer ' || (
                select decrypted_secret from vault.decrypted_secrets
                 where name = 'github_dispatch_token'
            ),
            'Content-Type', 'application/json',
            'User-Agent', 'grocery-tracker-nightly',
            'X-GitHub-Api-Version', '2022-11-28'
        ),
        timeout_milliseconds := 10000
    );
    $$
);
