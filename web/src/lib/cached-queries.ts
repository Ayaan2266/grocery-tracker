import { unstable_cache } from "next/cache";

import type { Direction, PriceChangeCount } from "./changes";
import {
  getCoverage,
  getPriceChangeCounts,
  getPriceChanges,
  getStores,
  type Coverage,
  type PriceChangePage,
  type Result,
  type StoreInfo,
} from "./queries";

/**
 * Reads that every page render makes and that change at most once a night:
 * the store list and the coverage counts. Kept in Next's data cache for a few
 * minutes, like the how-it-works status, so a page view costs the database
 * only the queries that depend on the visitor.
 *
 * A failed read throws inside the cache, so it is never stored, and comes back
 * out as an ordinary error result.
 */
const CACHE_SECONDS = 900;

function orThrow<T>(result: Result<T>): T {
  if (result.error !== null) throw new Error(result.error);
  return result.data;
}

async function settle<T>(load: () => Promise<T>): Promise<Result<T>> {
  try {
    return { data: await load(), error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const stores = unstable_cache(async () => orThrow(await getStores()), ["stores"], {
  revalidate: CACHE_SECONDS,
});

const coverage = unstable_cache(async () => orThrow(await getCoverage()), ["coverage"], {
  revalidate: CACHE_SECONDS,
});

export function getStoresCached(): Promise<Result<StoreInfo[]>> {
  return settle(stores);
}

export function getCoverageCached(): Promise<Result<Coverage | null>> {
  return settle(coverage);
}

const changeCounts = unstable_cache(async () => orThrow(await getPriceChangeCounts()), ["price-change-counts"], {
  revalidate: CACHE_SECONDS,
});

export function getPriceChangeCountsCached(): Promise<Result<PriceChangeCount[]>> {
  return settle(changeCounts);
}

/**
 * A night's changes change once a night too. The arguments are part of the
 * cache key, so each filter and page length is cached on its own; the store
 * list is sorted first so the same set always makes the same key.
 */
const changes = unstable_cache(
  async (day: string, direction: Direction, storeIds: number[] | null, limit: number) =>
    orThrow(await getPriceChanges({ day, direction, storeIds, limit })),
  ["price-changes"],
  { revalidate: CACHE_SECONDS },
);

export function getPriceChangesCached(options: {
  day: string;
  direction: Direction;
  storeIds: number[] | null;
  limit: number;
}): Promise<Result<PriceChangePage>> {
  const ids = options.storeIds === null ? null : [...options.storeIds].sort((a, b) => a - b);
  return settle(() => changes(options.day, options.direction, ids, options.limit));
}
