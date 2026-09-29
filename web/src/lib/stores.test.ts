import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BANNER_COLORS,
  BANNER_LABELS,
  BANNER_SHORT,
  inScope,
  isOntario,
  scopedStoreIds,
  shortStoreNames,
  storeArea,
  storeName,
} from "./stores.ts";

test("the place is whatever follows the banner in a store's label", () => {
  assert.equal(storeArea("Real Canadian Superstore - Winnipeg Kenaston"), "Winnipeg Kenaston");
  assert.equal(storeArea("No Frills - Vaughan"), "Vaughan");
  assert.equal(storeArea("Loblaws"), null);
  assert.equal(storeArea(""), null);
  assert.equal(storeArea(null), null);
  assert.equal(storeArea("Zehrs - "), null);
});

test("a store name carries its place when there is one", () => {
  assert.equal(storeName("superstore", "Real Canadian Superstore", "Real Canadian Superstore - Winnipeg Kenaston"), "Superstore · Winnipeg Kenaston");
  assert.equal(storeName("loblaw", "Loblaws", null), "Loblaws");
  assert.equal(storeName("provigo", "Provigo", "Provigo - Laval"), "Provigo · Laval");
});

test("every banner has a label, a short name and a colour", () => {
  const banners = Object.keys(BANNER_LABELS).sort();
  assert.deepEqual(Object.keys(BANNER_SHORT).sort(), banners);
  assert.deepEqual(Object.keys(BANNER_COLORS).sort(), banners);
  assert.equal(new Set(Object.values(BANNER_COLORS)).size, banners.length, "no two banners share a colour");
});

test("a store is in Ontario when its postal code starts with K, L, M, N or P", () => {
  for (const code of ["L4K 0C1", "M3J 3N4", "L9P 1N2", "K2M 0A7", "N2N 2Y2", "P3A 5H7", " m6a 3b4"]) {
    assert.equal(isOntario(code), true, code);
  }
  for (const code of ["R3N 2A1", "J9J 3Z4", "T2G 0G7", "V5M 1A1", "", null, undefined]) {
    assert.equal(isOntario(code), false, String(code));
  }
});

const tracked = [
  { id: 1, postal_code: "L4K 0C1" }, // No Frills, Vaughan
  { id: 2, postal_code: "R3N 2A1" }, // Superstore, Winnipeg
  { id: 3, postal_code: "L3P 1W2" }, // Loblaws, Markham
  { id: 6, postal_code: "J9J 3Z4" }, // Maxi, Gatineau
  { id: 7, postal_code: "M3J 3N4" }, // Superstore, Toronto
];

test("the Ontario scope keeps the Ontario stores and all keeps every store", () => {
  assert.deepEqual(scopedStoreIds(tracked, "ontario"), [1, 3, 7]);
  assert.equal(scopedStoreIds(tracked, "all"), null);
});

test("with no store known to be in Ontario, nothing is filtered out", () => {
  assert.equal(scopedStoreIds([], "ontario"), null);
  assert.equal(scopedStoreIds([{ id: 2, postal_code: "R3N 2A1" }], "ontario"), null);
  assert.equal(inScope(null, 2), true);
  assert.equal(inScope([1, 3, 7], 2), false);
  assert.equal(inScope([1, 3, 7], 7), true);
});

test("a banner at two stores is named with its place, a banner at one without", () => {
  const listing = (store_id: number, banner_slug: string, store_label: string) => ({
    store_id,
    banner_slug,
    retailer_name: BANNER_LABELS[banner_slug],
    store_label,
  });
  const toronto = listing(7, "superstore", "Real Canadian Superstore - Toronto Gerry Fitzgerald");
  const winnipeg = listing(2, "superstore", "Real Canadian Superstore - Winnipeg Kenaston");
  const vaughan = listing(1, "nofrills", "No Frills - Vaughan");

  const both = shortStoreNames([toronto, winnipeg, vaughan]);
  assert.equal(both(toronto), "Superstore · Toronto Gerry Fitzgerald");
  assert.equal(both(winnipeg), "Superstore · Winnipeg Kenaston");
  assert.equal(both(vaughan), "No Frills");

  const one = shortStoreNames([toronto, vaughan]);
  assert.equal(one(toronto), "Superstore");
});
