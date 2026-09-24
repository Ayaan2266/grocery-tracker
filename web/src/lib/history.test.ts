import assert from "node:assert/strict";
import { test } from "node:test";

import {
  badgeFor,
  chartPoints,
  dailyPrices,
  dayNumber,
  isoDay,
  latestDeal,
  latestSpan,
  rangePercent,
  summarize,
  windowSpans,
  type Span,
} from "./history.ts";

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

test("windowing clips spans to the last N days", () => {
  const clipped = windowSpans(
    [span("2026-09-01", "2026-09-20", 500), span("2026-09-21", "2026-09-30", 450)],
    "2026-09-30",
    14,
  );
  assert.deepEqual(
    clipped.map((s) => [s.first_observed_on, s.last_confirmed_on, s.price_cents]),
    [
      ["2026-09-17", "2026-09-20", 500],
      ["2026-09-21", "2026-09-30", 450],
    ],
  );
});

test("daily prices carry a span across its days and leave unseen days empty", () => {
  const values = dailyPrices(
    [span("2026-09-24", "2026-09-26", 500), span("2026-09-28", "2026-09-30", 450)],
    "2026-09-30",
    7,
  );
  assert.deepEqual(values, [500, 500, 500, null, 450, 450, 450]);
});

test("badges read the verdict in a few words", () => {
  const spans = [span("2026-09-21", "2026-09-26", 619), span("2026-09-27", "2026-09-30", 599)];
  assert.deepEqual(badgeFor(spans, 599), { label: "Lowest in 10 days", tone: "good" });
  assert.deepEqual(badgeFor([span("2026-09-21", "2026-09-30", 500)], 500), {
    label: "Steady price",
    tone: "neutral",
  });
  assert.equal(badgeFor([span("2026-09-30", "2026-09-30", 500)], 500), null);
});

test("range positions are clamped and survive a flat range", () => {
  assert.equal(rangePercent(599, 599, 619), 0);
  assert.equal(rangePercent(609, 599, 619), 50);
  assert.equal(rangePercent(700, 599, 619), 100);
  assert.equal(rangePercent(500, 500, 500), 50);
});

test("the latest span and the latest deal are found by date, not by order", () => {
  const sale = { ...span("2026-09-25", "2026-09-27", 549), was_price_cents: 644 };
  const hidden = { ...span("2026-09-10", "2026-09-12", 199), implied_regular_cents: 230 };
  const spans = [span("2026-09-28", "2026-09-30", 644), sale, hidden, span("2026-09-21", "2026-09-24", 644)];
  assert.equal(latestSpan(spans)?.first_observed_on, "2026-09-28");
  assert.deepEqual(latestDeal(spans), { span: sale, regular: 644, declared: true });
  assert.deepEqual(latestDeal([hidden]), { span: hidden, regular: 230, declared: false });
  assert.equal(latestDeal([span("2026-09-21", "2026-09-24", 644)]), null);
});
