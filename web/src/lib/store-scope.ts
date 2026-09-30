import { cookies } from "next/headers";

import { countByRegion, scopedStoreIds, secondaryStoreIds, type StoreScope } from "./stores";
import { getStores, type StoreInfo } from "./queries";

/**
 * Whether to show every store or only the Ontario ones, kept in a cookie for
 * the same reason as the basket: the server renders every page, so the choice
 * applies on the first paint and switching works with JavaScript off.
 * Absent means the default, Ontario.
 */
export const STORE_SCOPE_COOKIE = "loonie_stores";

export async function readStoreScope(): Promise<StoreScope> {
  const store = await cookies();
  return store.get(STORE_SCOPE_COOKIE)?.value === "all" ? "all" : "ontario";
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
};

/** The scope and the stores it covers, for one page render. */
export async function loadScopedStores(): Promise<ScopedStores> {
  const [scope, stores] = await Promise.all([readStoreScope(), getStores()]);
  const all = stores.data ?? [];
  const storeIds = scopedStoreIds(all, scope);
  const hidden = storeIds === null ? [] : all.filter((store) => !storeIds.includes(store.id));
  return {
    error: stores.error,
    scope,
    stores: all,
    storeIds,
    hidden,
    secondary: secondaryStoreIds(all),
    counts: countByRegion(all),
  };
}
