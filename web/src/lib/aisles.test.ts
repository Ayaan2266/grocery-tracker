import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AISLES, SEARCH_TERM_COUNT } from "./aisles.ts";

const targets = JSON.parse(
  readFileSync(new URL("../../../ingest/targets.json", import.meta.url), "utf8"),
) as { search_terms: Record<string, string[]> };

test("the aisles are the ingest's search groups, in order", () => {
  assert.deepEqual(
    AISLES.map((a) => a.key),
    Object.keys(targets.search_terms),
  );
});

test("each aisle's sample is one of its own search terms", () => {
  for (const aisle of AISLES) {
    assert.ok(
      targets.search_terms[aisle.key].includes(aisle.sample),
      `${aisle.sample} is not searched under ${aisle.key}`,
    );
  }
});

test("the term count matches what the ingest searches", () => {
  const distinct = new Set(Object.values(targets.search_terms).flat());
  assert.equal(SEARCH_TERM_COUNT, distinct.size);
});
