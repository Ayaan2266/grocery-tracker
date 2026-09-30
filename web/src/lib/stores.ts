/** Display names and graph colours for each banner, keyed by banner_slug. */
export const BANNER_LABELS: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Real Canadian Superstore",
  loblaw: "Loblaws",
  zehrs: "Zehrs",
  fortinos: "Fortinos",
  maxi: "Maxi",
};

/** Short names for tight spots: graph legends and basket columns. */
export const BANNER_SHORT: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Superstore",
  loblaw: "Loblaws",
  zehrs: "Zehrs",
  fortinos: "Fortinos",
  maxi: "Maxi",
};

/**
 * One colour per banner, never reassigned, so a store keeps its colour on
 * every graph whichever others appear beside it. Checked as a set against the
 * white chart surface, every pair against every other, for colour-blind
 * separation: the closest pair is ΔE 7.9, which is only acceptable because
 * the legend, tooltip and store lists always name the store in text too.
 */
export const BANNER_COLORS: Record<string, string> = {
  nofrills: "#c99700",
  superstore: "#df2140",
  loblaw: "#0b49bd",
  zehrs: "#15803d",
  fortinos: "#b5479f",
  maxi: "#0ea5b7",
};

export function bannerLabel(slug: string, fallback: string): string {
  return BANNER_LABELS[slug] ?? fallback;
}

/**
 * Where a store is, from its label: "Real Canadian Superstore - Winnipeg
 * Kenaston" gives "Winnipeg Kenaston". The stores are far apart, and a banner
 * can be tracked at more than one (Superstore in Toronto and in Winnipeg), so
 * a price never appears without the place it was recorded. Null for a label
 * with no place.
 */
export function storeArea(label: string | null | undefined): string | null {
  if (!label) return null;
  const at = label.indexOf(" - ");
  const area = at === -1 ? "" : label.slice(at + 3).trim();
  return area || null;
}

/** "Superstore · Winnipeg Kenaston", or just the banner when the place is unknown. */
export function storeName(slug: string, fallback: string, label: string | null | undefined): string {
  const area = storeArea(label);
  const name = BANNER_SHORT[slug] ?? fallback;
  return area ? `${name} · ${area}` : name;
}

/**
 * Canada Post gives every province its own first letters, and K, L, M, N and
 * P are Ontario's. A store with no postal code is not assumed to be anywhere.
 */
export function isOntario(postalCode: string | null | undefined): boolean {
  return /^[KLMNP]/i.test(postalCode?.trim() ?? "");
}

/**
 * Which stores the site shows. "ontario" is the default: Superstore in
 * Winnipeg and Maxi in Gatineau keep being checked every night, so their
 * history keeps growing, but a shopper in Ontario cannot buy there, and their
 * prices (and brands) follow another region.
 */
export type StoreScope = "ontario" | "all";

/**
 * The ids of the stores in scope, or null for no filter. Null too when no
 * store is known to be in Ontario, as when the store list failed to load:
 * showing every store beats showing nothing.
 */
export function scopedStoreIds(
  stores: { id: number; postal_code: string | null }[],
  scope: StoreScope,
): number[] | null {
  if (scope === "all") return null;
  const ids = stores.filter((store) => isOntario(store.postal_code)).map((store) => store.id);
  return ids.length > 0 ? ids : null;
}

export function inScope(storeIds: number[] | null, storeId: number): boolean {
  return storeIds === null || storeIds.includes(storeId);
}

type Named = { store_id: number; banner_slug: string; retailer_name: string; store_label: string | null };

/**
 * A short name for each store among `listings`: the banner alone, or the
 * banner and its place where the banner appears at more than one store, so two
 * Superstores never read as one.
 */
export function shortStoreNames<T extends Named>(listings: T[]): (listing: T) => string {
  const storesOf = new Map<string, Set<number>>();
  for (const listing of listings) {
    const stores = storesOf.get(listing.banner_slug) ?? new Set<number>();
    stores.add(listing.store_id);
    storesOf.set(listing.banner_slug, stores);
  }
  return (listing) =>
    (storesOf.get(listing.banner_slug)?.size ?? 0) > 1
      ? storeName(listing.banner_slug, listing.retailer_name, listing.store_label)
      : (BANNER_SHORT[listing.banner_slug] ?? listing.retailer_name);
}

type Located = { id: number; banner_slug: string; postal_code: string | null };

/**
 * Stores that are not their banner's first: they share its colour, so the site
 * draws them differently (a ring dot, a dashed line) instead of giving them a
 * colour of their own, which would break the colour-blind check above. Within a
 * banner the Ontario store comes first, then the one added earliest.
 */
export function secondaryStoreIds(stores: Located[]): Set<number> {
  const byBanner = new Map<string, Located[]>();
  for (const store of stores) byBanner.set(store.banner_slug, [...(byBanner.get(store.banner_slug) ?? []), store]);
  const secondary = new Set<number>();
  for (const group of byBanner.values()) {
    group
      .sort((a, b) => Number(isOntario(b.postal_code)) - Number(isOntario(a.postal_code)) || a.id - b.id)
      .slice(1)
      .forEach((store) => secondary.add(store.id));
  }
  return secondary;
}

/** How many stores are in Ontario and how many are not. */
export function countByRegion(stores: { postal_code: string | null }[]): { ontario: number; outside: number } {
  const ontario = stores.filter((store) => isOntario(store.postal_code)).length;
  return { ontario, outside: stores.length - ontario };
}
