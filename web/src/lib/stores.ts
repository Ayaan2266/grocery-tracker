import { distanceKm, type NearMe } from "./postal.ts";

/** Display names and graph colours for each banner, keyed by banner_slug. */
export const BANNER_LABELS: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Real Canadian Superstore",
  loblaw: "Loblaws",
  zehrs: "Zehrs",
  fortinos: "Fortinos",
};

/** Short names for tight spots: graph legends and basket columns. */
export const BANNER_SHORT: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Superstore",
  loblaw: "Loblaws",
  zehrs: "Zehrs",
  fortinos: "Fortinos",
};

/**
 * One colour per banner, never reassigned, so a store keeps its colour on
 * every graph whichever others appear beside it. Checked as a set against the
 * white chart surface, every pair against every other, for colour-blind
 * separation: no pair is closer than ΔE 7.9, which is only acceptable because
 * the legend, tooltip and store lists always name the store in text too.
 */
export const BANNER_COLORS: Record<string, string> = {
  nofrills: "#c99700",
  superstore: "#df2140",
  loblaw: "#0b49bd",
  zehrs: "#15803d",
  fortinos: "#b5479f",
};

export function bannerLabel(slug: string, fallback: string): string {
  return BANNER_LABELS[slug] ?? fallback;
}

/**
 * Where a store is, from its label: "Real Canadian Superstore - Toronto Don
 * Mills" gives "Toronto Don Mills". A banner can be tracked at more than one
 * store (four Superstores), and prices differ between them, so a price never
 * appears without the place it was recorded. Null for a label with no place.
 */
export function storeArea(label: string | null | undefined): string | null {
  if (!label) return null;
  const at = label.indexOf(" - ");
  const area = at === -1 ? "" : label.slice(at + 3).trim();
  return area || null;
}

/** "Superstore · Toronto Don Mills", or just the banner when the place is unknown. */
export function storeName(slug: string, fallback: string, label: string | null | undefined): string {
  const area = storeArea(label);
  const name = BANNER_SHORT[slug] ?? fallback;
  return area ? `${name} · ${area}` : name;
}

/**
 * Which stores the site shows. "all" is the default: every store checked
 * nightly, all of them in Ontario since db/migrations/0018 dropped the two
 * that were not. "near" is the stores within a radius of a postal code the
 * visitor gave.
 */
export type StoreScope = "all" | "near";

type Placed = { id: number; lat: number | null; lng: number | null };

/** The stores near a place, nearest first. */
export type NearStores = {
  /** Stores within the radius, and any whose place is unknown (see below). */
  ids: number[];
  /** Kilometres from the visitor, for each store whose place is known. */
  km: Map<number, number>;
  /** Stores with no coordinates: shown rather than hidden, with no distance. */
  unplaced: number[];
  /** True when nothing is within the radius and the nearest store stands in. */
  widened: boolean;
};

/**
 * The stores within `near.radiusKm`. A store whose place could not be found is
 * kept in, not dropped: a lookup that failed must not hide a store the visitor
 * might live next to. When nothing is in range the nearest one is shown, with
 * `widened` set so the page says it is further than asked, instead of an empty
 * site.
 */
export function nearbyStores(stores: Placed[], near: NearMe): NearStores {
  const km = new Map<number, number>();
  const unplaced: number[] = [];
  for (const store of stores) {
    if (store.lat === null || store.lng === null) unplaced.push(store.id);
    else km.set(store.id, distanceKm(near, { lat: store.lat, lng: store.lng }));
  }
  const byDistance = [...km.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const within = byDistance.filter(([, distance]) => distance <= near.radiusKm).map(([id]) => id);
  const widened = within.length === 0 && byDistance.length > 0;
  if (widened) within.push(byDistance[0][0]);
  return { ids: [...within, ...unplaced], km, unplaced, widened };
}

/**
 * The ids of the stores in scope, or null for no filter. Null too when no
 * store is near, as when the store list failed to load: showing every store
 * beats showing nothing. "near" without a place to be near is every store.
 */
export function scopedStoreIds(
  stores: { id: number; lat?: number | null; lng?: number | null }[],
  scope: StoreScope,
  near: NearMe | null = null,
): number[] | null {
  if (scope !== "near" || near === null) return null;
  const found = nearbyStores(
    stores.map((store) => ({ id: store.id, lat: store.lat ?? null, lng: store.lng ?? null })),
    near,
  );
  return found.ids.length > 0 ? found.ids : null;
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

type Located = { id: number; banner_slug: string };

/**
 * How a banner's stores are told apart. They share its colour, so each one
 * after the first gets its own line and dot instead of a colour of its own,
 * which would break the colour-blind check above. `dash` is an SVG
 * stroke-dasharray (null for solid) and `dot` the class that draws the dot
 * (null for filled; globals.css).
 */
export const STORE_MARKS = [
  { dash: null, dot: null },
  { dash: "6 4", dot: "is-ring" },
  { dash: "2 3", dot: "is-target" },
  { dash: "9 3 2 3", dot: "is-half" },
] as const;

export type StoreMark = (typeof STORE_MARKS)[number];

/** The mark for a store, by its index from storeMarks; the first store's for an unknown one. */
export function storeMark(index: number | undefined): StoreMark {
  return STORE_MARKS[index ?? 0] ?? STORE_MARKS[0];
}

/**
 * A dot in a banner's colour, drawn with a store's mark: filled for the first
 * store, and otherwise a class whose border and fill take the colour from
 * `color` (currentColor in globals.css).
 */
export function markDot(
  color: string,
  index: number | undefined,
): { className: string | null; style: { background?: string; borderColor?: string; color?: string } } {
  const { dot } = storeMark(index);
  return dot ? { className: dot, style: { borderColor: color, color } } : { className: null, style: { background: color } };
}

/**
 * Each store's mark, as an index into STORE_MARKS. Within a banner the store
 * added earliest comes first. Past the fourth store the marks after the first
 * repeat: a repeat never looks like the banner's first store, and the store is
 * named in text everywhere it appears.
 */
export function storeMarks(stores: Located[]): Map<number, number> {
  const byBanner = Map.groupBy(stores, (store) => store.banner_slug);
  const marks = new Map<number, number>();
  for (const group of byBanner.values()) {
    group
      .sort((a, b) => a.id - b.id)
      .forEach((store, rank) => marks.set(store.id, rank === 0 ? 0 : 1 + ((rank - 1) % (STORE_MARKS.length - 1))));
  }
  return marks;
}

/**
 * "7 stores", or "1 store". Empty when none are known (the list failed to
 * load), so a label built from it disappears rather than saying "0 stores".
 */
export function storeCountLabel(count: number): string {
  if (!Number.isInteger(count) || count < 1) return "";
  return `${count} ${count === 1 ? "store" : "stores"}`;
}
