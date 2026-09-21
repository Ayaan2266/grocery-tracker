import { createClient } from "@supabase/supabase-js";

/**
 * Read-only browser client. Only the anon key is exposed; every table is
 * behind row-level security with a public SELECT policy and no INSERT policy.
 * Ingestion does not go through this client, or through PostgREST at all: it
 * connects straight to Postgres with psycopg from GitHub Actions using
 * DATABASE_URL, which bypasses RLS entirely. Nothing writes from the browser.
 */
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);
