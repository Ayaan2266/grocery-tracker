import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Read-only client, created on first use rather than at module load.
 *
 * createClient throws on an empty URL, so constructing it at import time made
 * the whole module unimportable without credentials, and `next build` collects
 * page data by importing modules. CI has no Supabase credentials and should
 * not need any to prove the app compiles.
 *
 * Only the anon key is ever exposed. Every table and view is behind row level
 * security with a SELECT policy and no INSERT, UPDATE or DELETE policy, so
 * this key can read and nothing else. See db/migrations/0003_enable_rls.sql.
 *
 * Ingestion does not go through this client, or through PostgREST at all: it
 * connects straight to Postgres with psycopg from GitHub Actions using
 * DATABASE_URL, which bypasses RLS entirely. Nothing writes from the browser.
 */
let client: SupabaseClient | null = null;

/** Postgres's code for "canceling statement due to statement timeout". */
const STATEMENT_TIMEOUT = "57014";

/**
 * fetch, with one retry for a query the database cancelled at the anon role's
 * 3 s statement timeout. That happens to the first queries after the database
 * has sat idle, while what they read is still on disk, and the page said
 * "Price data is unavailable" for it. The retry finds the data cached and is
 * quick. Every other response, error or not, comes back as it was.
 */
async function fetchRetryingTimeouts(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status < 500) return response;
  const body = await response.clone().text();
  if (!body.includes(`"${STATEMENT_TIMEOUT}"`)) return response;
  return fetch(input, init);
}

export function getSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  client ??= createClient(url, key, { global: { fetch: fetchRetryingTimeouts } });
  return client;
}

export const MISSING_CREDENTIALS =
  "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. " +
  "Copy web/.env.example to web/.env.local and fill them in.";
