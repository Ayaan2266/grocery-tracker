/**
 * Which listings are the same item, and which are only similar.
 *
 * No imports, so `npm test` can run it on plain Node without a bundler.
 *
 * Every store shares most product codes, and a shared code is the same item.
 * ingest/match.py adds two keys to every listing (db/migrations/0010):
 *
 *   identity_key    brand + name words + exact package. Equal keys at two
 *                   stores are the same product listed under different codes,
 *                   as with No Name canola oil 946 ml at Superstore.
 *   substitute_key  name words + pack count + size, any brand. Equal keys are
 *                   similar products: Neilson 2% Milk 4 L and Beatrice
 *                   Partly Skimmed Milk 2% 4 L. Never the same item, never
 *                   priced into a basket as one.
 *
 * An identity key that two codes share at one store cannot say which of them
 * another store's listing is (Heinz Tomato Ketchup 750 mL has two codes at the
 * same No Frills, at different prices), so it is ignored and only the shared
 * code counts.
 */

export type Listing = {
  product_id: number;
  store_id: number;
  retailer_sku: string;
  price_cents: number;
  unit_price_cents: number | null;
  in_stock: boolean;
  identity_key?: string | null;
  substitute_key?: string | null;
};

/** Identity keys that more than one product code holds at the same store. */
export function ambiguousIdentityKeys(listings: Listing[]): Set<string> {
  const codeAt = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const listing of listings) {
    if (!listing.identity_key) continue;
    const slot = `${listing.store_id}|${listing.identity_key}`;
    const code = codeAt.get(slot);
    if (code === undefined) codeAt.set(slot, listing.retailer_sku);
    else if (code !== listing.retailer_sku) ambiguous.add(listing.identity_key);
  }
  return ambiguous;
}

export type SameItem<T> = {
  listing: T;
  /** True when the store lists it under the same product code. */
  byCode: boolean;
};

/**
 * At most one listing per store that is the same item as `product`, itself
 * included: the one with its product code, or else the one with its identity
 * key when that key is unambiguous.
 *
 * `candidates` must hold every listing with the product's identity key, not
 * just some of them, or an ambiguous key can look unambiguous.
 */
export function sameItemListings<T extends Listing>(product: T, candidates: T[]): SameItem<T>[] {
  const everything = [product, ...candidates];
  const ambiguous = ambiguousIdentityKeys(everything);
  const key =
    product.identity_key && !ambiguous.has(product.identity_key) ? product.identity_key : null;

  const byStore = new Map<number, SameItem<T>>();
  for (const listing of everything) {
    const current = byStore.get(listing.store_id);
    if (listing.retailer_sku === product.retailer_sku) {
      if (!current?.byCode) byStore.set(listing.store_id, { listing, byCode: true });
    } else if (key !== null && listing.identity_key === key && current === undefined) {
      byStore.set(listing.store_id, { listing, byCode: false });
    }
  }
  return [...byStore.values()];
}

/**
 * In-stock listings similar to `product`, cheapest by unit price first: the
 * same description, size and pack under another brand or code. Leaves out
 * the listings in `sameItem`.
 */
export function similarListings<T extends Listing>(
  product: T,
  candidates: T[],
  sameItem: Set<number>,
  limit = 6,
): T[] {
  if (!product.substitute_key) return [];
  const byUnitPrice = (a: T, b: T) =>
    (a.unit_price_cents ?? Number.POSITIVE_INFINITY) - (b.unit_price_cents ?? Number.POSITIVE_INFINITY) ||
    a.price_cents - b.price_cents;
  return candidates
    .filter(
      (listing) =>
        listing.substitute_key === product.substitute_key &&
        listing.in_stock &&
        !sameItem.has(listing.product_id) &&
        listing.retailer_sku !== product.retailer_sku,
    )
    .sort(byUnitPrice)
    .slice(0, limit);
}
