import assert from "node:assert/strict";
import { test } from "node:test";

import { chartPoints, dayNumber, isoDay, summarize, type Span } from "./history.ts";

function span(first: string, last: string, price: number): Span {
  return {
    first_observed_on: first,
    last_confirmed_on: last,
    price_cents: price,
    was_price_cents: null,
    in_stock: true,
  };
}

test("day numbers round-trip", () => {
  assert.equal(isoDay(dayNumber("2026-09-24")), "2026-09-24");
  assert.equal(dayNumber("2026-09-25") - dayNumber("2026-09-24"), 1);
});

test("a single day of history is new, not a verdict", () => {
  assert.equal(summarize([span("2026-09-24", "2026-09-24", 500)], 500)?.kind, "new");
});

test("no history reads null", () => {
  assert.equal(summarize([], 500), null);
});

test("an unchanged price is steady", () => {
  const verdict = summarize([span("2026-09-21", "2026-09-24", 500)], 500);
  assert.equal(verdict?.kind, "steady");
  assert.equal(verdict?.daysTracked, 4);
  assert.equal(verdict?.since, "2026-09-21");
});

test("typical is weighted by days, not by rows", () => {
  // $5.00 for 10 days, $3.00 for 1 day, $6.00 for 1 day.
  const spans = [
    span("2026-09-01", "2026-09-10", 500),
    span("2026-09-11", "2026-09-11", 300),
    span("2026-09-12", "2026-09-12", 600),
  ];
  const verdict = summarize(spans, 600);
  assert.equal(verdict?.typical, 500);
  assert.equal(verdict?.lowest, 300);
  assert.equal(verdict?.highest, 600);
  assert.equal(verdict?.kind, "above");
});

test("today's price is placed against the history", () => {
  const spans = [span("2026-09-01", "2026-09-20", 500), span("2026-09-21", "2026-09-24", 399)];
  assert.equal(summarize(spans, 399)?.kind, "lowest");
  assert.equal(summarize(spans, 450)?.kind, "below");
  assert.equal(summarize(spans, 500)?.kind, "typical");
});

test("the graph has a point at each span edge, one line per series", () => {
  const points = chartPoints([
    { key: "a", spans: [span("2026-09-21", "2026-09-23", 500), span("2026-09-24", "2026-09-24", 450)] },
    { key: "b", spans: [span("2026-09-22", "2026-09-24", 480)] },
  ]);
  assert.deepEqual(
    points.map((p) => [isoDay(p.day), p.a, p.b]),
    [
      ["2026-09-21", 500, null],
      ["2026-09-22", 500, 480],
      ["2026-09-23", 500, 480],
      ["2026-09-24", 450, 480],
    ],
  );
});

test("a day a product went unseen is null, not a price", () => {
  const points = chartPoints([
    { key: "a", spans: [span("2026-09-21", "2026-09-21", 500), span("2026-09-23", "2026-09-23", 500)] },
    { key: "b", spans: [span("2026-09-22", "2026-09-22", 480)] },
  ]);
  assert.deepEqual(
    points.map((p) => p.a),
    [500, null, 500],
  );
});
