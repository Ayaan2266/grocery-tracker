import assert from "node:assert/strict";
import { test } from "node:test";

import { BANNER_COLORS, BANNER_LABELS, BANNER_SHORT, storeArea, storeName } from "./stores.ts";

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
