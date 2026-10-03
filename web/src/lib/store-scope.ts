import { cookies } from "next/headers";

import { lookupFsa } from "./geocode";
import { decodeNear, parsePostalCode, type NearMe, type Point } from "./postal";
import {
  countByRegion,
  nearbyStores,
  scopedStoreIds,
  secondaryStoreIds,
  type NearStores,
  type StoreScope,
} from "./stores";
import { getStores, type StoreInfo } from "./queries";

/**
 * Which stores to show, kept in cookies for the same reason as the basket: the
 * server renders every page, so the choice applies on the first paint and
 * switching works with JavaScript off.
 *
 *   loonie_stores  "all" or "near". Absent means the default, Ontario.
 *   loonie_near    the place the visitor gave, as lib/postal.ts encodes it:
 *                  the FSA ("L4K"), its centre and the radius. Never a full
 *                  postal code.
 */
export const STORE_SCOPE_COOKIE = "loonie_stores";
export const NEAR_COOKIE = "loonie_near";

/** The scope and the place behind "near", read from the cookies. */
export async function readStorePreference(): Promise<{ scope: StoreScope; near: NearMe | null }> {
  const jar = await cookies();
  const near = decodeNear(jar.get(NEAR_COOKIE)?.value);
  const chosen = jar.get(STORE_SCOPE_COOKIE)?.value;
  // "near" with no readable place behind it is the default, not an empty site.
  const scope: StoreScope = chosen === "all" ? "all" : chosen === "near" && near ? "near" : "ontario";
  return { scope, near };
}

/**
 * Every store with a place: its own coordinates when the database has them,
 * otherwise the centre of the postal-code area it is in. Only called once a
 * visitor has asked for stores near them, so nobody else triggers a lookup.
 * Lookups are cached for a month (lib/postal.ts). A store that cannot be placed
 * stays unplaced and is shown, not hidden (nearbyStores).
 */
async function placeStores(stores: StoreInfo[]): Promise<StoreInfo[]> {
  const areas = new Set<string>();
  for (const store of stores) {
    if (store.lat !== null && store.lng !== null) continue;
    const fsa = parsePostalCode(store.postal_code ?? "");
    if (fsa) areas.add(fsa);
  }
  const found = new Map<string, Point | null>(
    await Promise.all([...areas].map(async (fsa) => [fsa, await lookupFsa(fsa)] as const)),
  );
  return stores.map((store) => {
    if (store.lat !== null && store.lng !== null) return store;
    const point = found.get(parsePostalCode(store.postal_code ?? "") ?? "") ?? null;
    return point ? { ...store, lat: point.lat, lng: point.lng } : store;
  });
}

export type ScopedStores = {
  error: string | null;
  scope: StoreScope;
  /** Every store checked nightly, in scope or not. */
  stores: StoreInfo[];
  /** The stores the site shows, or null for every store. */
  storeIds: number[] | null;
  /** Stores checked nightly that the current scope leaves out. */
  hidden: StoreInfo[];
  /** Stores drawn with a ring dot and a dashed line: not their banner's first. */
  secondary: Set<number>;
  counts: { ontario: number; outside: number };
  /** The place the visitor gave, whichever scope is on. */
  near: NearMe | null;
  /** The stores near that place, nearest first, whichever scope is on. */
  nearStores: NearStores | null;
};

/** The scope and the stores it covers, for one page render. */
export async function loadScopedStores(): Promise<ScopedStores> {
  const [{ scope, near }, loaded] = await Promise.all([readStorePreference(), getStores()]);
  const known = loaded.data ?? [];
  const all = near ? await placeStores(known) : known;
  const nearStores = near ? nearbyStores(all, near) : null;
  const storeIds = scopedStoreIds(all, scope, near);
  const hidden = storeIds === null ? [] : all.filter((store) => !storeIds.includes(store.id));
  return {
    error: loaded.error,
    scope,
    stores: all,
    storeIds,
    hidden,
    secondary: secondaryStoreIds(all),
    counts: countByRegion(all),
    near,
    nearStores,
  };
}
