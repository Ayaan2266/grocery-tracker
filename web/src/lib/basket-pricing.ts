import type { Basket } from "./basket.ts";
import { sameItemListings, similarListings } from "./matching.ts";
import type { LatestPrice } from "./queries.ts";
import { inScope } from "./stores.ts";

export type BasketLine = {
  product: LatestPrice;
  quantity: number;
  byStore: Map<number, LatestPrice>;
  outOfStock: Map<number, LatestPrice>;
  cheapest: LatestPrice | null;
  /** Similar items are suggestions, never part of a total. */
  cheaperSimilar: LatestPrice | null;
};

/** Match across all stores before filtering by region, preserving ambiguity checks. */
export function buildBasketLines(
  basket: Basket,
  products: LatestPrice[],
  candidates: LatestPrice[],
  similarCandidates: LatestPrice[],
  storeIds: number[] | null,
): BasketLine[] {
  const byId = new Map(products.map((product) => [product.product_id, product]));
  const similarInScope = similarCandidates.filter((listing) => inScope(storeIds, listing.store_id));
  const lines: BasketLine[] = [];
  for (const [id, quantity] of basket) {
    const product = byId.get(id);
    if (!product) continue;
    const matched = sameItemListings(product, candidates);
    const byStore = new Map<number, LatestPrice>();
    const outOfStock = new Map<number, LatestPrice>();
    let cheapest: LatestPrice | null = null;
    for (const { listing } of matched) {
      if (!inScope(storeIds, listing.store_id)) continue;
      (listing.in_stock ? byStore : outOfStock).set(listing.store_id, listing);
      if (listing.in_stock && (cheapest === null || listing.price_cents < cheapest.price_cents)) {
        cheapest = listing;
      }
    }
    // Filter by comparable units before picking the cheapest suggestion.
    const [cheaperSimilar] = similarListings(
      product,
      similarInScope.filter((listing) =>
        cheapest !== null && listing.unit_price_cents !== null && cheapest.unit_price_cents !== null &&
        listing.comparison_unit === cheapest.comparison_unit &&
        listing.comparison_quantity === cheapest.comparison_quantity &&
        listing.unit_price_cents < cheapest.unit_price_cents,
      ),
      new Set(matched.map(({ listing }) => listing.product_id)),
      1,
    );
    lines.push({ product, quantity, byStore, outOfStock, cheapest, cheaperSimilar: cheaperSimilar ?? null });
  }
  return lines;
}

export type BasketTotal = {
  storeId: number;
  total: number;
  carried: number;
  missing: number;
  outOfStock: number;
};

/** In-stock, in-scope prices only. Unavailable products keep a basket incomplete. */
export function summarizeBasket(lines: BasketLine[], storeIds: number[], unavailable = 0) {
  const totals: BasketTotal[] = storeIds.map((storeId) => {
    let total = 0;
    let carried = 0;
    let outOfStock = 0;
    for (const line of lines) {
      const listing = line.byStore.get(storeId);
      if (listing) {
        total += listing.price_cents * line.quantity;
        carried += 1;
      } else if (line.outOfStock.has(storeId)) {
        outOfStock += 1;
      }
    }
    return { storeId, total, carried, outOfStock, missing: lines.length + unavailable - carried - outOfStock };
  });
  const complete = totals.filter((total) => total.missing === 0 && total.outOfStock === 0 && lines.length > 0);
  const bestComplete = complete.reduce<BasketTotal | null>(
    (best, total) => best === null || total.total < best.total ? total : best,
    null,
  );
  let mixTotal = 0;
  let mixCount = 0;
  for (const line of lines) {
    if (!line.cheapest) continue;
    mixTotal += line.cheapest.price_cents * line.quantity;
    mixCount += 1;
  }
  return { totals, bestComplete, mixTotal, mixMissing: lines.length + unavailable - mixCount };
}
