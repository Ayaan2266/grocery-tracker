import assert from "node:assert/strict";
import { test } from "node:test";

import { ambiguousIdentityKeys, sameItemListings, similarListings, type Listing } from "./matching.ts";

// Stores as seeded: 1 No Frills, 2 Superstore, 3 Loblaws.
let nextId = 1;
function listing(store: number, sku: string, overrides: Partial<Listing> = {}): Listing {
  return {
    product_id: nextId++,
    store_id: store,
    retailer_sku: sku,
    price_cents: 500,
    unit_price_cents: 50,
    in_stock: true,
    identity_key: null,
    substitute_key: null,
    ...overrides,
  };
}

const CANOLA = "noname|canola oil pure|1|946ml";

test("a shared code is the same item at every store", () => {
  const here = listing(1, "20188873_EA");
  const there = listing(3, "20188873_EA");
  const other = listing(2, "20000001_EA");
  const found = sameItemListings(here, [here, there, other]);
  assert.deepEqual(
    found.map((s) => [s.listing.store_id, s.byCode]),
    [
      [1, true],
      [3, true],
    ],
  );
});

test("an identity key finds the same product under another code", () => {
  // No Name canola oil: 20088990_EA at No Frills and Loblaws, 21594669_EA at Superstore.
  const nofrills = listing(1, "20088990_EA", { identity_key: CANOLA });
  const loblaw = listing(3, "20088990_EA", { identity_key: CANOLA });
  const superstore = listing(2, "21594669_EA", { identity_key: CANOLA });
  const found = sameItemListings(nofrills, [loblaw, superstore]);
  assert.deepEqual(
    found.map((s) => [s.listing.store_id, s.byCode]).sort(),
    [
      [1, true],
      [2, false],
      [3, true],
    ],
  );
});

test("the shared code wins over an identity match at the same store", () => {
  const key = "brand|thing|1|100g";
  const here = listing(1, "A_EA", { identity_key: key });
  const lookalike = listing(3, "B_EA", { identity_key: key });
  const same = listing(3, "A_EA", { identity_key: key });
  // B and A both hold the key at store 3, so the key is ambiguous there too.
  const found = sameItemListings(here, [lookalike, same]);
  assert.deepEqual(
    found.map((s) => [s.listing.retailer_sku, s.byCode]),
    [
      ["A_EA", true],
      ["A_EA", true],
    ],
  );
});

test("an identity key two codes share at one store is ignored", () => {
  // Heinz Tomato Ketchup 750 mL: two codes at the same No Frills.
  const key = "heinz|ketchup tomato|1|750ml";
  const a = listing(1, "20115102001_EA", { identity_key: key, price_cents: 579 });
  const b = listing(1, "20021486_EA", { identity_key: key, price_cents: 799 });
  const loblaw = listing(3, "20115102001_EA", { identity_key: key });
  assert.deepEqual([...ambiguousIdentityKeys([a, b, loblaw])], [key]);
  const found = sameItemListings(b, [a, loblaw]);
  assert.deepEqual(
    found.map((s) => s.listing.retailer_sku),
    ["20021486_EA"],
    "only the listing itself: its code is at no other store",
  );
});

test("listings without keys still pair by code, as before the keys existed", () => {
  const here = listing(1, "X_EA", { identity_key: undefined });
  const there = listing(2, "X_EA", { identity_key: undefined });
  assert.equal(sameItemListings(here, [there]).length, 2);
});

test("similar items are other products with the substitute key, by unit price", () => {
  const key = "2% milk|1|4000ml";
  const neilson = listing(1, "20188873_EA", { substitute_key: key, unit_price_cents: 16 });
  const neilsonLoblaw = listing(3, "20188873_EA", { substitute_key: key, unit_price_cents: 16 });
  const beatrice = listing(2, "20658152_EA", { substitute_key: key, unit_price_cents: 15 });
  const kawartha = listing(3, "20166716001_EA", { substitute_key: key, unit_price_cents: 18 });
  const soldOut = listing(1, "21522143_EA", { substitute_key: key, unit_price_cents: 5, in_stock: false });
  const unrelated = listing(1, "20148677_EA", { substitute_key: "2% microfiltered milk|1|4000ml" });

  const similar = similarListings(
    neilson,
    [neilsonLoblaw, beatrice, kawartha, soldOut, unrelated],
    new Set([neilson.product_id, neilsonLoblaw.product_id]),
  );
  assert.deepEqual(
    similar.map((l) => l.retailer_sku),
    ["20658152_EA", "20166716001_EA"],
  );
});

test("nothing is similar to a listing without a substitute key", () => {
  const here = listing(1, "A_EA");
  assert.deepEqual(similarListings(here, [listing(2, "B_EA")], new Set()), []);
});
