import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changeReason,
  changeSpoken,
  changeText,
  changesHref,
  dayHeading,
  isFlyerNight,
  isWeighed,
  latestChangeDay,
  parseDirection,
  parseStoreFilter,
  percentText,
  tally,
  type PriceChangeCount,
} from "./changes.ts";

test("the direction defaults to drops", () => {
  assert.equal(parseDirection(undefined), "down");
  assert.equal(parseDirection("up"), "up");
  assert.equal(parseDirection("sideways"), "down");
});

test("a store filter only counts when the page shows that store", () => {
  assert.equal(parseStoreFilter("7", [1, 7]), 7);
  assert.equal(parseStoreFilter("2", [1, 7]), null, "out of scope");
  for (const bad of [undefined, "", "0", "-3", "1.5", "7abc", "9999999999"]) {
    assert.equal(parseStoreFilter(bad, [7]), null, String(bad));
  }
});

const counts: PriceChangeCount[] = [
  { store_id: 1, changed_on: "2026-10-15", drops: 10, rises: 4 },
  { store_id: 2, changed_on: "2026-10-15", drops: 3, rises: 6 },
  // Store 3 did not run last night: its changes are a day old.
  { store_id: 3, changed_on: "2026-10-14", drops: 50, rises: 50 },
];

test("the page reports the newest night, and a store a night behind is left out", () => {
  assert.equal(latestChangeDay(counts), "2026-10-15");
  assert.equal(latestChangeDay([]), null);
  const all = tally(counts, "2026-10-15", null);
  assert.deepEqual([all.drops, all.rises], [13, 10]);
  assert.equal(all.byStore.has(3), false);
});

test("the tally follows the store scope", () => {
  const scoped = tally(counts, "2026-10-15", [2, 3]);
  assert.deepEqual([scoped.drops, scoped.rises], [3, 6]);
  assert.deepEqual([...scoped.byStore.keys()], [2]);
});

test("changes read as an amount and a percentage, with the direction spoken", () => {
  assert.equal(changeText({ change_cents: -250, change_percent: "-31.3" }), "$2.50 · 31%");
  assert.equal(changeText({ change_cents: 4, change_percent: 0.6 }), "$0.04 · 0.6%");
  assert.equal(changeSpoken({ change_cents: -250, change_percent: -31.3 }), "down $2.50, 31%");
  assert.equal(changeSpoken({ change_cents: 50, change_percent: 8 }), "up $0.50, 8%");
  assert.equal(percentText(-1), "1%");
});

test("a sale starting or ending is named, and nothing else is guessed", () => {
  assert.equal(changeReason({ change_cents: -100, was_price_cents: 599, previous_was_price_cents: null }), "sale-started");
  assert.equal(changeReason({ change_cents: 100, was_price_cents: null, previous_was_price_cents: 599 }), "sale-ended");
  assert.equal(changeReason({ change_cents: -100, was_price_cents: null, previous_was_price_cents: null }), null);
  assert.equal(
    changeReason({ change_cents: 100, was_price_cents: 699, previous_was_price_cents: 599 }),
    null,
    "a sale price that went up is still a sale, not one ending",
  );
});

test("days are read as calendar dates, whatever the server's time zone", () => {
  assert.equal(dayHeading("2026-10-15"), "Thursday, October 15");
  assert.equal(isFlyerNight("2026-10-15"), true);
  assert.equal(isFlyerNight("2026-10-14"), false);
});

test("links keep the filters and leave out the defaults", () => {
  assert.equal(changesHref({ direction: "down", store: null }), "/changes");
  assert.equal(changesHref({ direction: "up", store: 7 }), "/changes?dir=up&store=7");
  assert.equal(changesHref({ direction: "down", store: null, count: 60 }), "/changes?n=60");
});

test("items sold by weight are told apart by their _KG code, as ingestion does", () => {
  assert.equal(isWeighed({ retailer_sku: "20036155001_KG" }), true, "loose Brussels sprouts");
  assert.equal(isWeighed({ retailer_sku: "21456738001_EA" }), false, "the 907 g bag");
  assert.equal(isWeighed({ retailer_sku: "21104064_EA" }), false);
  assert.equal(isWeighed({ retailer_sku: "20036155001KG" }), false, "the underscore is part of the suffix");
});
