import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBasketLines, summarizeBasket } from "./basket-pricing.ts";
import type { LatestPrice } from "./queries.ts";

function listing(id: number, store: number, sku: string, price: number, extra: Partial<LatestPrice> = {}): LatestPrice {
  return {
    product_id: id, store_id: store, retailer_sku: sku, price_cents: price,
    raw_name: sku, brand: "Brand", package_size: "100 g", size_value: 100, size_unit: "g",
    store_code: String(store), store_label: null, banner_slug: "nofrills", retailer_name: "No Frills",
    observed_on: "2026-09-30", was_price_cents: null, unit_price_cents: price,
    comparison_unit: "g", comparison_quantity: 100, unit_price_source: "derived", in_stock: true,
    ...extra,
  };
}

test("totals multiply quantities and pick a complete shop and a cheaper mix", () => {
  const milk = listing(1, 1, "milk", 500);
  const bread = listing(2, 1, "bread", 300);
  const candidates = [milk, bread, listing(3, 2, "milk", 400), listing(4, 2, "bread", 400)];
  const lines = buildBasketLines(new Map([[1, 2], [2, 1]]), [milk, bread], candidates, [], null);
  const summary = summarizeBasket(lines, [1, 2]);
  assert.deepEqual(summary.totals.map((t) => t.total), [1300, 1200]);
  assert.equal(summary.bestComplete?.storeId, 2);
  assert.equal(summary.mixTotal, 1100);
  assert.equal(summary.mixMissing, 0);
});

test("stock and scope apply even when a product has only one listing", () => {
  const outside = listing(1, 2, "milk", 500);
  const out = listing(2, 1, "bread", 300, { in_stock: false });
  const lines = buildBasketLines(new Map([[1, 2], [2, 1]]), [outside, out], [], [], [1]);
  const summary = summarizeBasket(lines, [1]);
  assert.equal(summary.totals[0].total, 0);
  assert.equal(summary.totals[0].missing, 1);
  assert.equal(summary.totals[0].outOfStock, 1);
  assert.equal(summary.bestComplete, null);
  assert.equal(summary.mixTotal, 0);
  assert.equal(summary.mixMissing, 2);
});

test("an unavailable cookie product prevents an incomplete basket winning", () => {
  const milk = listing(1, 1, "milk", 500);
  const lines = buildBasketLines(new Map([[1, 1], [99, 1]]), [milk], [], [], null);
  const summary = summarizeBasket(lines, [1], 1);
  assert.equal(summary.bestComplete, null);
  assert.equal(summary.totals[0].missing, 1);
  assert.equal(summary.mixMissing, 1);
});

test("ambiguity outside the selected region still prevents a false identity", () => {
  const milk = listing(1, 1, "A", 500, { identity_key: "milk" });
  const candidates = [
    listing(2, 2, "B", 400, { identity_key: "milk" }),
    listing(3, 3, "C", 300, { identity_key: "milk" }),
    listing(4, 3, "D", 200, { identity_key: "milk" }),
  ];
  const lines = buildBasketLines(new Map([[1, 1]]), [milk], candidates, [], [1, 2]);
  assert.deepEqual([...lines[0].byStore.keys()], [1]);
});

test("similar suggestions compare matching units and never change totals", () => {
  const milk = listing(1, 1, "A", 500, { substitute_key: "milk" });
  const wrongUnit = listing(2, 2, "B", 100, { substitute_key: "milk", comparison_unit: "ml" });
  const similar = listing(3, 2, "C", 400, { substitute_key: "milk" });
  const lines = buildBasketLines(new Map([[1, 1]]), [milk], [], [wrongUnit, similar], null);
  assert.equal(lines[0].cheaperSimilar?.product_id, 3);
  assert.equal(summarizeBasket(lines, [1, 2]).mixTotal, 500);
});

test("basket lines preserve cookie order regardless of database order", () => {
  const products = [listing(1, 1, "A", 100), listing(2, 1, "B", 200)];
  const lines = buildBasketLines(new Map([[2, 1], [1, 1]]), products, [], [], null);
  assert.deepEqual(lines.map((line) => line.product.product_id), [2, 1]);
});
