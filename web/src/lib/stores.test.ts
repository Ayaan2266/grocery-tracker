import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BANNER_COLORS,
  BANNER_LABELS,
  BANNER_SHORT,
  inScope,
  nearbyStores,
  scopedStoreIds,
  STORE_MARKS,
  storeCountLabel,
  storeMark,
  storeMarks,
  shortStoreNames,
  storeArea,
  storeName,
} from "./stores.ts";

test("the place is whatever follows the banner in a store's label", () => {
  assert.equal(storeArea("Real Canadian Superstore - Toronto Don Mills"), "Toronto Don Mills");
  assert.equal(storeArea("No Frills - Vaughan"), "Vaughan");
  assert.equal(storeArea("Loblaws"), null);
  assert.equal(storeArea(""), null);
  assert.equal(storeArea(null), null);
  assert.equal(storeArea("Zehrs - "), null);
});

test("a store name carries its place when there is one", () => {
  assert.equal(storeName("superstore", "Real Canadian Superstore", "Real Canadian Superstore - Toronto Don Mills"), "Superstore · Toronto Don Mills");
  assert.equal(storeName("loblaw", "Loblaws", null), "Loblaws");
  assert.equal(storeName("provigo", "Provigo", "Provigo - Laval"), "Provigo · Laval");
});

test("every banner has a label, a short name and a colour", () => {
  const banners = Object.keys(BANNER_LABELS).sort();
  assert.deepEqual(Object.keys(BANNER_SHORT).sort(), banners);
  assert.deepEqual(Object.keys(BANNER_COLORS).sort(), banners);
  assert.equal(new Set(Object.values(BANNER_COLORS)).size, banners.length, "no two banners share a colour");
});

const tracked = [{ id: 1 }, { id: 3 }, { id: 7 }]; // Vaughan, Markham, Toronto

test("every store is in scope by default", () => {
  assert.equal(scopedStoreIds(tracked, "all"), null);
  assert.equal(scopedStoreIds([], "all"), null);
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
  const donMills = listing(11, "superstore", "Real Canadian Superstore - Toronto Don Mills");
  const vaughan = listing(1, "nofrills", "No Frills - Vaughan");

  const both = shortStoreNames([toronto, donMills, vaughan]);
  assert.equal(both(toronto), "Superstore · Toronto Gerry Fitzgerald");
  assert.equal(both(donMills), "Superstore · Toronto Don Mills");
  assert.equal(both(vaughan), "No Frills");

  const one = shortStoreNames([toronto, vaughan]);
  assert.equal(one(toronto), "Superstore");
});

test("each store of a banner gets its own mark, the one added first first", () => {
  const stores = [
    { id: 1, banner_slug: "nofrills" },
    { id: 4, banner_slug: "zehrs" },
    { id: 11, banner_slug: "superstore" }, // Don Mills
    { id: 7, banner_slug: "superstore" }, // Gerry Fitzgerald, added first
    { id: 12, banner_slug: "superstore" }, // Weston Road
  ];
  const marks = storeMarks(stores);
  assert.deepEqual(
    [7, 11, 12].map((id) => marks.get(id)),
    [0, 1, 2],
    "Gerry Fitzgerald first, then Don Mills, then Weston Road: three different marks",
  );
  assert.equal(marks.get(1), 0);
  assert.equal(marks.get(4), 0);
  assert.ok([...storeMarks(stores.slice(0, 3)).values()].every((mark) => mark === 0), "one store per banner: nothing to tell apart");
});

test("a banner's marks are all different, and past the fourth never the first store's", () => {
  const stores = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, banner_slug: "nofrills" }));
  const marks = [...storeMarks(stores).values()];
  assert.deepEqual(marks.slice(0, STORE_MARKS.length), [0, 1, 2, 3]);
  assert.ok(marks.slice(1).every((mark) => mark !== 0));
  const looks = STORE_MARKS.map((mark) => `${mark.dash}|${mark.dot}`);
  assert.equal(new Set(looks).size, STORE_MARKS.length, "no two marks draw the same line and dot");
  assert.equal(storeMark(undefined), STORE_MARKS[0]);
  assert.equal(storeMark(99), STORE_MARKS[0]);
});

// Where the stores are, to the nearest few kilometres: Vaughan, Markham,
// Uxbridge, North York and Toronto (Gerry Fitzgerald).
const placed = [
  { id: 1, lat: 43.8, lng: -79.5 },
  { id: 3, lat: 43.87, lng: -79.27 },
  { id: 4, lat: 44.11, lng: -79.12 },
  { id: 5, lat: 43.72, lng: -79.45 },
  { id: 7, lat: 43.76, lng: -79.49 },
];
const vaughan = { fsa: "L4K", lat: 43.7947, lng: -79.4812, radiusKm: 25 };

test("the stores near a place are those within the radius, nearest first", () => {
  const near = nearbyStores(placed, vaughan);
  assert.deepEqual(near.ids, [1, 7, 5, 3]);
  assert.equal(near.widened, false);
  assert.deepEqual(near.unplaced, []);
  assert.ok(near.km.get(1)! < near.km.get(7)! && near.km.get(7)! < near.km.get(5)!);
  assert.ok(near.km.get(4)! > 25, "Uxbridge is out of range");
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

test("a store that could not be placed is kept in, never hidden", () => {
  const some = placed.map((store) => (store.id === 5 ? { ...store, lat: null, lng: null } : store));
  const near = nearbyStores(some, vaughan);
  assert.deepEqual(near.unplaced, [5]);
  assert.deepEqual(near.ids, [1, 7, 3, 5]);
  assert.equal(near.km.has(5), false);

  const none = nearbyStores(placed.map((s) => ({ ...s, lat: null, lng: null })), vaughan);
  assert.deepEqual(none.ids, [1, 3, 4, 5, 7]);
  assert.equal(none.widened, false);
});

test("the near scope uses the place, and without one it is every store", () => {
  assert.deepEqual(scopedStoreIds(placed, "near", vaughan), [1, 7, 5, 3]);
  assert.equal(scopedStoreIds(placed, "near", null), null);
  assert.equal(scopedStoreIds(placed, "all", vaughan), null);
  assert.deepEqual(scopedStoreIds(tracked, "near", vaughan), [1, 3, 7], "stores with no coordinates are kept in");
  assert.equal(scopedStoreIds([], "near", vaughan), null);
});

test("the store count reads as a label, and is blank when there is none", () => {
  assert.equal(storeCountLabel(7), "7 stores");
  assert.equal(storeCountLabel(2), "2 stores");
  assert.equal(storeCountLabel(1), "1 store");
  for (const none of [0, -1, Number.NaN, 1.5]) assert.equal(storeCountLabel(none), "", String(none));
});
