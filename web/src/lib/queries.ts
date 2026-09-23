import { getSupabase, MISSING_CREDENTIALS } from "./supabase";

/**
 * One row of `product_latest_price`: a product carrying its most recent
 * observation. The view exists because PostgREST cannot order and limit an
 * embedded resource per parent, which is what "latest price per product"
 * needs. Created in db/migrations/0004_product_latest_price.sql, redefined over
 * price_spans with the same columns in 0006_store_price_changes_only.sql.
 */
export type LatestPrice = {
  product_id: number;
  retailer_sku: string;
  raw_name: string;
  brand: string | null;
  package_size: string | null;
  size_value: number | null;
  size_unit: string | null;
  store_id: number;
  store_code: string;
  store_label: string | null;
  banner_slug: string;
  retailer_name: string;
  observed_on: string;
  price_cents: number;
  was_price_cents: number | null;
  unit_price_cents: number | null;
  comparison_unit: string | null;
  comparison_quantity: number | null;
  unit_price_source: "api" | "derived" | "none";
  in_stock: boolean;
};

export type Coverage = {
  products: number;
  observations: number;
  days: number;
  first_day: string | null;
  last_day: string | null;
};

/**
 * A query either returns rows or explains why it could not.
 *
 * Swallowing the error and rendering an empty list would make "the anon key
 * cannot read this table" look identical to "no products matched", and those
 * take very different fixes.
 */
export type Result<T> = { data: T; error: null } | { data: null; error: string };

/** `%` and `_` are wildcards in ILIKE, so a search for "50%" must not mean "50 anything". */
function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export async function searchProducts(
  term: string,
  limit = 60,
): Promise<Result<LatestPrice[]>> {
  const trimmed = term.trim();
  if (!trimmed) return { data: [], error: null };

  const supabase = getSupabase();
  if (!supabase) return { data: null, error: MISSING_CREDENTIALS };

  const { data, error } = await supabase
    .from("product_latest_price")
    .select("*")
    .ilike("raw_name", `%${escapeLikePattern(trimmed)}%`)
    .order("price_cents", { ascending: true })
    .limit(limit);

  if (error) return { data: null, error: error.message };
  return { data: (data ?? []) as LatestPrice[], error: null };
}

export async function getCoverage(): Promise<Result<Coverage | null>> {
  const supabase = getSupabase();
  if (!supabase) return { data: null, error: MISSING_CREDENTIALS };

  const { data, error } = await supabase
    .from("ingest_coverage")
    .select("*")
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  return { data: (data as Coverage) ?? null, error: null };
}
