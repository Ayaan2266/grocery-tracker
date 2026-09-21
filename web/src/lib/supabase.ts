import { createClient } from "@supabase/supabase-js";

/**
 * Read-only browser client. Only the anon key is exposed; every table is
 * behind row-level security with a public SELECT policy and no INSERT policy.
 * Ingestion writes with the service role from GitHub Actions, never from here.
 */
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);
