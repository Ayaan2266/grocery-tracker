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
  /**
   * The regular price behind a deal the store does not mark as a sale,
   * rebuilt from its own unit price. Approximate, and inferred rather than
   * declared, so it is never shown as `was_price_cents`. Absent (not just
   * null) on a database without migration 0007.
   */
  implied_regular_cents?: number | null;
  /**
   * True when the unit price was worked out by migration 0008 for a price
   * recorded before 2026-09-24, rather than stored with it.
   */
  unit_price_backfilled?: boolean;
  /**
   * Cross-store matching keys from ingest/match.py; see lib/matching.ts.
   * Absent on a database without migration 0010, null where the package
   * size does not parse.
   */
  identity_key?: string | null;
  substitute_key?: string | null;
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

export type SortOrder = "price" | "value";

export const PAGE_SIZE = 60;
/** A "Show more" link can ask for at most this many rows in one request. */
export const MAX_RESULTS = 600;

export type SearchPage = { rows: LatestPrice[]; hasMore: boolean };

/**
 * One page of search results, cheapest first.
 *
 * "price" is the shelf price. "value" is the unit price, which puts a 4 L jug
 * and a 1 L carton on the same scale. Products with no unit price go last
 * there rather than first, since nothing is known about their value.
 *
 * Asks for one row more than it shows, which is how "Show more" knows there
 * is more without a second count query.
 */
export async function searchProducts(
  term: string,
  { sort = "price", limit = PAGE_SIZE }: { sort?: SortOrder; limit?: number } = {},
): Promise<Result<SearchPage>> {
  const trimmed = term.trim();
  if (!trimmed) return { data: { rows: [], hasMore: false }, error: null };

  const supabase = getSupabase();
  if (!supabase) return { data: null, error: MISSING_CREDENTIALS };

  const capped = Math.min(Math.max(limit, 1), MAX_RESULTS);
  let query = supabase
    .from("product_latest_price")
    .select("*")
    .ilike("raw_name", `%${escapeLikePattern(trimmed)}%`);
  query =
    sort === "value"
      ? query
          .order("unit_price_cents", { ascending: true, nullsFirst: false })
          .order("price_cents", { ascending: true })
      : query.order("price_cents", { ascending: true });
  const { data, error } = await query.order("product_id").limit(capped + 1);

  if (error) return { data: null, error: error.message };
  const rows = (data ?? []) as LatestPrice[];
  return { data: { rows: rows.slice(0, capped), hasMore: rows.length > capped }, error: null };
}

/** One product with its latest price, or null when there is no such product. */
export async function getProduct(productId: number): Promise<Result<LatestPrice | null>> {
  const supabase = getSupabase();
  if (!supabase) return { data: null, error: MISSING_CREDENTIALS };

  const { data, error } = await supabase
    .from("product_latest_price")
    .select("*")
    .eq("product_id", productId)
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  return { data: (data as LatestPrice) ?? null, error: null };
}

/**
 * Latest prices for products, by id. Used by the basket, which stores ids.
 */
export async function getProducts(productIds: number[]): Promise<Result<LatestPrice[]>> {
  if (productIds.length === 0) return { data: [], error: null };
  const supabase = getSupabase();
  if (!supabase) return { data: null, error: MISSING_CREDENTIALS };

  const { data, error } = await supabase
    .from("product_latest_price")
    .select("*")
    .in("product_id", productIds);

  if (error) return { data: null, error: error.message };
  return { data: (data ?? []) as LatestPrice[], error: null };
}

/**
 * PostgREST `in` list with every value quoted. Match keys contain "." and
 * "|", and quoting is what keeps a "." from being read as syntax.
 */
function inList(values: string[]): string {
  return `(${values.map((v) => `"${v.replace(/["\\]/g, "\\$&")}"`).join(",")})`;
}

/**
 * Every listing that may be the same item as one of these products: each
 * store's listing of their product codes, plus every listing that shares one
 * of their identity keys. lib/matching.ts decides which of them are.
 *
 * Every Loblaw banner runs on the same PCX platform, so an identical product
 * usually carries the same code at each one that stocks it. When it does not
 * (Superstore lists some national-brand and No Name items under its own
 * codes), the identity key finds it. A product no other store carries simply
 * comes back once, and the page shows no comparison rather than a wrong one.
 */
export async function getSameItemCandidates(
  products: LatestPrice[],
): Promise<Result<LatestPrice[]>> {
  if (products.length === 0) return { data: [], error: null };
  const supabase = getSupabase();
  if (!supabase) return { data: null, error: MISSING_CREDENTIALS };

  const skus = [...new Set(products.map((p) => p.retailer_sku))];
  const keys = [...new Set(products.map((p) => p.identity_key).filter((k): k is string => !!k))];
  const [bySku, byKey] = await Promise.all([
    supabase.from("product_latest_price").select("*").in("retailer_sku", skus),
    keys.length > 0
      ? supabase.from("product_latest_price").select("*").filter("identity_key", "in", inList(keys))
      : Promise.resolve({ data: [], error: null }),
  ]);
  const error = bySku.error ?? byKey.error;
  if (error) return { data: null, error: error.message };

  const unique = new Map<number, LatestPrice>();
  for (const row of [...(bySku.data ?? []), ...(byKey.data ?? [])] as LatestPrice[]) {
    unique.set(row.product_id, row);
  }
  return { data: [...unique.values()], error: null };
}

/** Listings that share a substitute key: similar items, never the same one. */
export async function getSimilarCandidates(keys: string[]): Promise<Result<LatestPrice[]>> {
  if (keys.length === 0) return { data: [], error: null };
  const supabase = getSupabase();
  if (!supabase) return { data: null, error: MISSING_CREDENTIALS };

  const { data, error } = await supabase
    .from("product_latest_price")
    .select("*")
    .filter("substitute_key", "in", inList(keys))
    .order("unit_price_cents", { ascending: true, nullsFirst: false })
    .limit(100);

  if (error) return { data: null, error: error.message };
  return { data: (data ?? []) as LatestPrice[], error: null };
}

/**
 * One stretch of unchanged values for one product, from `price_spans`.
 *
 * Read directly rather than through the daily `price_observations` view: a
 * year of one item at three stores is over a thousand daily rows, which is
 * past Supabase's default response cap, while the same history as spans is a
 * few dozen rows.
 */
export type PriceSpan = {
  product_id: number;
  first_observed_on: string;
  last_confirmed_on: string;
  price_cents: number;
  was_price_cents: number | null;
  implied_regular_cents?: number | null;
  in_stock: boolean;
};

/**
 * Spans that overlap the days since `sinceIso`, for many products at once:
 * the search rows' sparklines and badges.
 *
 * A product has at most one span per day, so 30 products over a 30-day
 * window stay under Supabase's 1,000-row response cap. Newest first, so if a
 * longer window ever does hit the cap, the oldest days are the ones dropped.
 * The chunks run in parallel.
 */
export async function getRecentHistory(
  productIds: number[],
  sinceIso: string,
): Promise<Result<PriceSpan[]>> {
  if (productIds.length === 0) return { data: [], error: null };
  const supabase = getSupabase();
  if (!supabase) return { data: null, error: MISSING_CREDENTIALS };

  const chunks: number[][] = [];
  for (let i = 0; i < productIds.length; i += 30) chunks.push(productIds.slice(i, i + 30));
  const responses = await Promise.all(
    chunks.map((ids) =>
      supabase
        .from("price_spans")
        .select("*")
        .in("product_id", ids)
        .gte("last_confirmed_on", sinceIso)
        .order("first_observed_on", { ascending: false }),
    ),
  );
  const failed = responses.find((r) => r.error);
  if (failed?.error) return { data: null, error: failed.error.message };
  return { data: responses.flatMap((r) => (r.data ?? []) as PriceSpan[]), error: null };
}

export async function getPriceHistory(productIds: number[]): Promise<Result<PriceSpan[]>> {
  if (productIds.length === 0) return { data: [], error: null };
  const supabase = getSupabase();
  if (!supabase) return { data: null, error: MISSING_CREDENTIALS };

  const { data, error } = await supabase
    .from("price_spans")
    .select("*")
    .in("product_id", productIds)
    .order("first_observed_on", { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data: (data ?? []) as PriceSpan[], error: null };
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
