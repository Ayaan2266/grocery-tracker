import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchAll } from "./pagination.ts";

test("history and candidates beyond 1,000 rows are all returned in order", async () => {
  const rows = Array.from({ length: 1_237 }, (_, id) => ({ id }));
  const requested: number[][] = [];
  const result = await fetchAll(async (from, to) => {
    requested.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  });
  assert.deepEqual(result, { data: rows, error: null });
  assert.deepEqual(requested, [[0, 499], [500, 999], [1000, 1499]]);
});

test("a failed later page never returns a plausible partial history", async () => {
  const result = await fetchAll<number>(async (from) => from === 0
    ? { data: Array(500).fill(1), error: null }
    : { data: null, error: { message: "database unavailable" } });
  assert.deepEqual(result, { data: null, error: "database unavailable" });
});

test("an exact full page is followed by an empty page", async () => {
  let calls = 0;
  const result = await fetchAll(async (from) => {
    calls += 1;
    return { data: from === 0 ? Array(500).fill(1) : [], error: null };
  });
  assert.equal(result.data?.length, 500);
  assert.equal(calls, 2);
});
