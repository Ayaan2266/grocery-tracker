import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  getPriceChanges,
  getPriceHistory,
  getSameItemCandidates,
  getSimilarCandidates,
  searchProducts,
  type LatestPrice,
} from "./queries.ts";

const originalFetch = globalThis.fetch;
let requests: URL[];
let bodies: unknown[];
let respond: (url: URL, body: unknown) => Response;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-key";
  requests = [];
  bodies = [];
  respond = () => Response.json([]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push(url);
    bodies.push(body);
    return respond(url, body);
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });

test("search asks the ranked search for one row more than a page, in the stores in scope", async () => {
  respond = () => Response.json(Array.from({ length: 4 }, (_, i) => ({ product_id: i })));
  const page = await searchProducts("  milk ", { sort: "value", limit: 3, storeIds: [2, 5] });
  assert.equal(requests[0].pathname, "/rest/v1/rpc/search_products");
  assert.deepEqual(bodies[0], { search_term: "milk", store_ids: [2, 5], sort_by: "value", max_rows: 4 });
  assert.equal(page.data?.rows.length, 3);
  assert.equal(page.data?.hasMore, true);
  assert.equal(page.data?.correctedTo, undefined);
  assert.equal(requests.length, 1, "a search that finds something is not spell-checked");
});

test("a search that finds nothing is run again with its spelling corrected", async () => {
  respond = (url, body) => {
    if (url.pathname.endsWith("/search_suggestion")) return Response.json("banana");
    const term = (body as { search_term: string }).search_term;
    return Response.json(term === "banana" ? [{ product_id: 7, raw_name: "Bananas, Bunch" }] : []);
  };
  const page = await searchProducts("banaana");
  assert.deepEqual(requests.map((r) => r.pathname), [
    "/rest/v1/rpc/search_products",
    "/rest/v1/rpc/search_suggestion",
    "/rest/v1/rpc/search_products",
  ]);
  assert.deepEqual(bodies[1], { search_term: "banaana" });
  assert.equal(page.data?.correctedTo, "banana");
  assert.deepEqual(page.data?.rows.map((r) => r.product_id), [7]);
});

test("a search with nothing close to correct comes back empty, not as an error", async () => {
  respond = (url) => Response.json(url.pathname.endsWith("/search_suggestion") ? null : []);
  const page = await searchProducts("zzqqx");
  assert.equal(page.error, null);
  assert.deepEqual(page.data, { rows: [], hasMore: false });
  assert.equal(requests.length, 2);
});

test("before migration 0020 search falls back to ILIKE, grouping units before value", async () => {
  respond = (url) => url.pathname.startsWith("/rest/v1/rpc/")
    ? Response.json({ code: "PGRST202", message: "Could not find the function" }, { status: 404 })
    : Response.json([]);
  const page = await searchProducts("50%", { sort: "value" });
  assert.equal(page.error, null);
  const legacy = requests[1];
  assert.equal(legacy.pathname, "/rest/v1/product_latest_price");
  assert.equal(legacy.searchParams.get("raw_name"), "ilike.%50\\%%");
  const order = legacy.searchParams.get("order")!;
  assert.ok(order.indexOf("comparison_unit") < order.indexOf("unit_price_cents"));
});

test("a failed search reports its error rather than no results", async () => {
  respond = () => Response.json({ code: "57014", message: "canceling statement due to statement timeout" }, { status: 500 });
  const page = await searchProducts("milk");
  assert.equal(page.data, null);
  assert.match(page.error ?? "", /statement timeout/);
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

test("price drops ask for one night's drops, biggest percentage first", async () => {
  await getPriceChanges({ day: "2026-10-15", direction: "down", storeIds: [3, 7], limit: 40 });
  const params = requests[0].searchParams;
  assert.equal(requests[0].pathname, "/rest/v1/price_changes");
  assert.equal(params.get("changed_on"), "eq.2026-10-15");
  assert.equal(params.get("change_cents"), "lt.0");
  assert.equal(params.get("store_id"), "in.(3,7)");
  assert.equal(params.get("order"), "change_percent.asc,change_cents.asc,product_id.asc");
  assert.equal(params.get("limit"), "41", "one extra row tells Show more there is more");
});

test("price increases sort the other way, and every store is read when none is chosen", async () => {
  respond = () => Response.json(Array.from({ length: 3 }, (_, i) => ({ product_id: i })));
  const page = await getPriceChanges({ day: "2026-10-15", direction: "up", storeIds: null, limit: 2 });
  const params = requests[0].searchParams;
  assert.equal(params.get("change_cents"), "gt.0");
  assert.equal(params.get("store_id"), null);
  assert.equal(params.get("order"), "change_percent.desc,change_cents.desc,product_id.asc");
  assert.equal(page.data?.rows.length, 2);
  assert.equal(page.data?.hasMore, true);
});

test("price changes can keep only packaged items, or only items sold by weight", async () => {
  await getPriceChanges({ day: "2026-10-17", direction: "down", storeIds: null, limit: 40, weighed: false });
  await getPriceChanges({ day: "2026-10-17", direction: "down", storeIds: null, limit: 12, weighed: true });
  await getPriceChanges({ day: "2026-10-17", direction: "down", storeIds: null, limit: 40 });
  // A literal underscore: "_" alone in LIKE would match any one character.
  assert.equal(requests[0].searchParams.get("retailer_sku"), "not.like.%\\_KG");
  assert.equal(requests[1].searchParams.get("retailer_sku"), "like.%\\_KG");
  assert.equal(requests[2].searchParams.get("retailer_sku"), null, "both kinds when left out");
});

test("deal and size filters become the database conditions changeReason describes", async () => {
  await getPriceChanges({ day: "2026-10-17", direction: "down", storeIds: null, deal: "sale", minPercent: 25 });
  await getPriceChanges({ day: "2026-10-17", direction: "down", storeIds: null, deal: "unmarked" });
  await getPriceChanges({ day: "2026-10-17", direction: "up", storeIds: null, deal: "ended", minPercent: 10 });
  await getPriceChanges({ day: "2026-10-17", direction: "up", storeIds: null, deal: "unmarked" });
  const [saleDown, unmarkedDown, endedUp, unmarkedUp] = requests.map((r) => r.searchParams);
  assert.equal(saleDown.get("was_price_cents"), "not.is.null");
  assert.equal(saleDown.get("change_percent"), "lte.-25");
  assert.equal(unmarkedDown.get("was_price_cents"), "is.null");
  assert.equal(endedUp.get("previous_was_price_cents"), "not.is.null");
  assert.equal(endedUp.get("was_price_cents"), "is.null");
  assert.equal(endedUp.get("change_percent"), "gte.10");
  assert.equal(unmarkedUp.get("or"), "(previous_was_price_cents.is.null,was_price_cents.not.is.null)");
});

test("a page of changes reports how many match in all", async () => {
  respond = () => new Response("[]", { headers: { "content-type": "application/json", "content-range": "0-0/57" } });
  const page = await getPriceChanges({ day: "2026-10-17", direction: "down", storeIds: null, minPercent: 50 });
  assert.equal(page.data?.total, 57);
});

test("the list can be ordered by price or by name, with product id last for stable pages", async () => {
  const sorts = ["price-asc", "price-desc", "name-asc", "name-desc", "change"] as const;
  for (const sort of sorts) await getPriceChanges({ day: "2026-10-17", direction: "down", storeIds: null, sort });
  assert.deepEqual(
    requests.map((r) => r.searchParams.get("order")),
    [
      "price_cents.asc,raw_name.asc,product_id.asc",
      "price_cents.desc,raw_name.asc,product_id.asc",
      "raw_name.asc,price_cents.asc,product_id.asc",
      "raw_name.desc,price_cents.asc,product_id.asc",
      "change_percent.asc,change_cents.asc,product_id.asc",
    ],
  );
});
