import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { getPriceHistory, getSameItemCandidates, getSimilarCandidates, searchProducts, type LatestPrice } from "./queries.ts";

const originalFetch = globalThis.fetch;
let requests: URL[];
let respond: (url: URL) => Response;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-key";
  requests = [];
  respond = () => Response.json([]);
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    return respond(url);
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });

test("unit-price search groups dimensions before ranking value", async () => {
  await searchProducts("milk", { sort: "value" });
  const order = requests[0].searchParams.get("order")!;
  assert.ok(order.indexOf("comparison_unit") < order.indexOf("unit_price_cents"));
});

test("full history includes prices after the response cap", async () => {
  const rows = Array.from({ length: 1237 }, (_, id) => ({ product_id: id, price_cents: id }));
  respond = (url) => {
    const start = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return Response.json(rows.slice(start, start + limit));
  };
  const history = await getPriceHistory([1]);
  assert.deepEqual(history.data, rows);
  assert.equal(requests.length, 3);
});

test("a late ambiguous identity candidate is never silently dropped", async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({ product_id: i + 1 }));
  respond = (url) => {
    if (!url.searchParams.has("identity_key")) return Response.json([]);
    const start = Number(url.searchParams.get("offset"));
    return Response.json(rows.slice(start, start + Number(url.searchParams.get("limit"))));
  };
  const candidates = await getSameItemCandidates([
    { retailer_sku: "milk", identity_key: "brand|milk|4000ml" } as LatestPrice,
  ]);
  assert.equal(candidates.data?.length, 1001);
  assert.equal(candidates.data?.at(-1)?.product_id, 1001);
});

test("similar products beyond the former global 100-row limit are retained", async () => {
  const rows = Array.from({ length: 137 }, (_, i) => ({ product_id: i + 1 }));
  respond = () => Response.json(rows);
  assert.equal((await getSimilarCandidates(["milk", "bread"])).data?.length, 137);
});
