import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BANNER_COLORS,
  BANNER_LABELS,
  BANNER_SHORT,
  countByRegion,
  inScope,
  isOntario,
  nearbyStores,
  scopedStoreIds,
  secondaryStoreIds,
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

test("a banner's second store is the one drawn differently, Ontario first", () => {
  const stores = [
    { id: 1, banner_slug: "nofrills", postal_code: "L4K 0C1" },
    { id: 2, banner_slug: "superstore", postal_code: "R3N 2A1" }, // Winnipeg, added first
    { id: 6, banner_slug: "maxi", postal_code: "J9J 3Z4" },
    { id: 7, banner_slug: "superstore", postal_code: "M3J 3N4" }, // Toronto
    { id: 9, banner_slug: "superstore", postal_code: "L4G 7Y3" }, // Aurora, a later GTA store
  ];
  assert.deepEqual([...secondaryStoreIds(stores)].sort(), [2, 9]);
  assert.equal(secondaryStoreIds(stores.slice(0, 3)).size, 0, "one store per banner: nothing to tell apart");
});

test("stores are counted by region", () => {
  assert.deepEqual(countByRegion(tracked), { ontario: 3, outside: 2 });
  assert.deepEqual(countByRegion([]), { ontario: 0, outside: 0 });
});

// Where the stores are, to the nearest few kilometres: Vaughan, Markham,
// Uxbridge, North York, Toronto (Gerry Fitzgerald), Winnipeg and Gatineau.
const placed = [
  { id: 1, postal_code: "L4K 0C1", lat: 43.8, lng: -79.5 },
  { id: 2, postal_code: "R3N 2A1", lat: 49.85, lng: -97.2 },
  { id: 3, postal_code: "L3P 1W2", lat: 43.87, lng: -79.27 },
  { id: 4, postal_code: "L9P 1N2", lat: 44.11, lng: -79.12 },
  { id: 5, postal_code: "M6A 3B4", lat: 43.72, lng: -79.45 },
  { id: 6, postal_code: "J9J 3Z4", lat: 45.39, lng: -75.84 },
  { id: 7, postal_code: "M3J 3N4", lat: 43.76, lng: -79.49 },
];
const vaughan = { fsa: "L4K", lat: 43.7947, lng: -79.4812, radiusKm: 25 };

test("the stores near a place are those within the radius, nearest first", () => {
  const near = nearbyStores(placed, vaughan);
  assert.deepEqual(near.ids, [1, 7, 5, 3]);
  assert.equal(near.widened, false);
  assert.deepEqual(near.unplaced, []);
  assert.ok(near.km.get(1)! < near.km.get(7)! && near.km.get(7)! < near.km.get(5)!);
  assert.ok(near.km.get(2)! > 1000, "Winnipeg is far away");
});

test("a bigger radius brings in more stores and a smaller one fewer", () => {
  assert.deepEqual(nearbyStores(placed, { ...vaughan, radiusKm: 10 }).ids, [1, 7, 5]);
  assert.deepEqual(nearbyStores(placed, { ...vaughan, radiusKm: 50 }).ids, [1, 7, 5, 3, 4]);
  assert.deepEqual(nearbyStores(placed, { ...vaughan, radiusKm: 100 }).ids, [1, 7, 5, 3, 4]);
});

test("with nothing in range the nearest store stands in, and says so", () => {
  const barrie = { fsa: "L4N", lat: 44.39, lng: -79.69, radiusKm: 10 };
  const near = nearbyStores(placed, barrie);
  assert.equal(near.widened, true);
  assert.deepEqual(near.ids, [4]);
});

test("a visitor in Winnipeg gets the Winnipeg store: near is not Ontario-only", () => {
  const winnipeg = { fsa: "R3N", lat: 49.86, lng: -97.21, radiusKm: 25 };
  assert.deepEqual(nearbyStores(placed, winnipeg).ids, [2]);
});

test("a store that could not be placed is kept in, never hidden", () => {
  const some = placed.map((store) => (store.id === 5 ? { ...store, lat: null, lng: null } : store));
  const near = nearbyStores(some, vaughan);
  assert.deepEqual(near.unplaced, [5]);
  assert.deepEqual(near.ids, [1, 7, 3, 5]);
  assert.equal(near.km.has(5), false);

  const none = nearbyStores(placed.map((s) => ({ ...s, lat: null, lng: null })), vaughan);
  assert.deepEqual(none.ids, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(none.widened, false);
});

test("the near scope uses the place, and without one it is Ontario", () => {
  assert.deepEqual(scopedStoreIds(placed, "near", vaughan), [1, 7, 5, 3]);
  assert.deepEqual(scopedStoreIds(placed, "near", null), [1, 3, 4, 5, 7]);
  assert.equal(scopedStoreIds(placed, "all", vaughan), null);
  assert.deepEqual(scopedStoreIds(placed, "ontario", vaughan), [1, 3, 4, 5, 7]);
  assert.deepEqual(scopedStoreIds(tracked, "ontario"), [1, 3, 7], "stores with no coordinates still work");
  assert.equal(scopedStoreIds([], "near", vaughan), null);
});
