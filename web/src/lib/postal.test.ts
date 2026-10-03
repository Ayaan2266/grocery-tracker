import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_NEAR_RADIUS,
  NEAR_RADII,
  decodeNear,
  distanceKm,
  encodeNear,
  geocodeFsa,
  inCanada,
  parsePostalCode,
  parseRadius,
  cachedLookup,
  type FetchLike,
  type Point,
} from "./postal.ts";

test("every way of writing a postal code gives the same area", () => {
  for (const typed of ["L4K", "l4k", " L4K ", "L4K 0C1", "l4k0c1", "L4K-0C1", "L4K\t0C1"]) {
    assert.equal(parsePostalCode(typed), "L4K", typed);
  }
});

test("a Canadian postal code starts with a letter Canada Post uses for a province", () => {
  for (const code of ["A1A", "B3H", "C1A", "E1A", "G1A", "H2X", "J9J", "K2M", "L3P", "M6A", "N2N", "P3A", "R3N", "S4P", "T2G", "V5M", "X1A", "Y1A"]) {
    assert.equal(parsePostalCode(code), code, code);
  }
  // D, F, I, O, Q, U are never used, W and Z never start one.
  for (const code of ["D1A", "F1A", "I1A", "O1A", "Q1A", "U1A", "W1A", "Z1A"]) {
    assert.equal(parsePostalCode(code), null, code);
  }
  // The third character may be W or Z, but still not D, F, I, O, Q, U.
  assert.equal(parsePostalCode("L4W"), "L4W");
  assert.equal(parsePostalCode("L4Z"), "L4Z");
  assert.equal(parsePostalCode("L4D"), null);
  assert.equal(parsePostalCode("L4U 0C1"), null);
});

test("anything else is not a postal code", () => {
  for (const typed of ["", " ", "L4", "L4K 0", "L4K 0C", "L4K 0C1 9", "44K 0C1", "LLK", "L44", "90210", "10001", "L4K 0C1; DROP", "L4K\n0C1x"]) {
    assert.equal(parsePostalCode(typed), null, JSON.stringify(typed));
  }
});

test("a radius is one of the offered ones, else the default", () => {
  for (const km of NEAR_RADII) assert.equal(parseRadius(String(km)), km);
  for (const bad of ["0", "-5", "30", "abc", "", null, undefined]) {
    assert.equal(parseRadius(bad), DEFAULT_NEAR_RADIUS, String(bad));
  }
  assert.ok((NEAR_RADII as readonly number[]).includes(DEFAULT_NEAR_RADIUS));
});

test("distance is a great circle in kilometres", () => {
  const toronto = { lat: 43.6532, lng: -79.3832 };
  const ottawa = { lat: 45.4215, lng: -75.6972 };
  const km = distanceKm(toronto, ottawa);
  assert.ok(km > 345 && km < 360, `Toronto to Ottawa is about 350 km, got ${km}`);
  assert.equal(distanceKm(toronto, toronto), 0);
  assert.ok(Math.abs(distanceKm(toronto, ottawa) - distanceKm(ottawa, toronto)) < 1e-9);
  // Across the country: Vaughan to Winnipeg is about 1,500 km.
  const far = distanceKm({ lat: 43.8, lng: -79.5 }, { lat: 49.85, lng: -97.2 });
  assert.ok(far > 1450 && far < 1550, String(far));
});

test("a saved place round-trips through its cookie", () => {
  const near = { fsa: "L4K", lat: 43.79474, lng: -79.48123, radiusKm: 25 };
  const value = encodeNear(near);
  assert.equal(value, "L4K|43.7947|-79.4812|25");
  assert.deepEqual(decodeNear(value), { fsa: "L4K", lat: 43.7947, lng: -79.4812, radiusKm: 25 });
});

test("a cookie that is missing, mangled or out of range is no place at all", () => {
  for (const value of [
    undefined,
    null,
    "",
    "L4K",
    "L4K|43.7|-79.4",
    "L4K|43.7|-79.4|25|extra",
    "L4K|north|-79.4|25",
    "L4K|43.7|-79.4|30", // not an offered radius
    "L4K|0|0|25", // nowhere near Canada
    "L4K|43.7|79.4|25", // longitude's sign dropped
    "D4K|43.7|-79.4|25", // not a postal area
    "L4K 0C1|43.7|-79.4|25", // a full postal code is never stored
    "L4K|NaN|-79.4|25",
    "L4K|Infinity|-79.4|25",
  ]) {
    assert.equal(decodeNear(value), null, String(value));
  }
});

test("Canada's box includes its far corners and leaves the rest of the world out", () => {
  for (const point of [
    { lat: 43.65, lng: -79.38 }, // Toronto
    { lat: 49.85, lng: -97.2 }, // Winnipeg
    { lat: 60.72, lng: -135.05 }, // Whitehorse
    { lat: 47.56, lng: -52.71 }, // St. John's
    { lat: 82.5, lng: -62.3 }, // Alert
  ]) {
    assert.equal(inCanada(point), true, JSON.stringify(point));
  }
  for (const point of [
    { lat: 40.71, lng: -74.0 }, // New York
    { lat: 51.5, lng: -0.12 }, // London
    { lat: 0, lng: 0 },
    { lat: Number.NaN, lng: -79 },
  ]) {
    assert.equal(inCanada(point), false, JSON.stringify(point));
  }
});

function respond(body: unknown, init: ResponseInit = {}): FetchLike {
  return async () => new Response(JSON.stringify(body), { status: 200, ...init });
}

const concord = {
  "post code": "L4K",
  country: "Canada",
  places: [{ "place name": "Concord", latitude: "43.7947", longitude: "-79.4812" }],
};

test("a lookup returns the first place's coordinates as numbers", async () => {
  assert.deepEqual(await geocodeFsa("L4K", { fetchImpl: respond(concord) }), { lat: 43.7947, lng: -79.4812 });
});

test("a lookup asks for the area only, never anything longer", async () => {
  const urls: string[] = [];
  const spy: FetchLike = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(concord));
  };
  await geocodeFsa("L4K", { fetchImpl: spy });
  assert.deepEqual(urls, ["https://api.zippopotam.us/ca/L4K"]);
  // Not an FSA: no request at all.
  assert.equal(await geocodeFsa("L4K 0C1", { fetchImpl: spy }), null);
  assert.equal(await geocodeFsa("nonsense", { fetchImpl: spy }), null);
  assert.equal(urls.length, 1);
});

test("a different service can be named, and is asked the same way", async () => {
  const urls: string[] = [];
  const spy: FetchLike = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(concord));
  };
  await geocodeFsa("L4K", { fetchImpl: spy, baseUrl: "http://localhost:9/ca/" });
  assert.deepEqual(urls, ["http://localhost:9/ca/L4K"]);
});

test("every way a lookup can fail reads as not found, and none throws", async () => {
  const attempts: FetchLike[] = [
    respond({}, { status: 404 }),
    respond(concord, { status: 500 }),
    respond({}),
    respond({ places: [] }),
    respond({ places: "none" }),
    respond({ places: [{ latitude: "x", longitude: "y" }] }),
    respond({ places: [{}] }),
    respond({ places: [{ latitude: "40.71", longitude: "-74.0" }] }), // New York, not Canada
    respond(null),
    async () => new Response("<html>not json</html>", { status: 200 }),
    async () => {
      throw new Error("network down");
    },
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  ];
  for (const [index, attempt] of attempts.entries()) {
    assert.equal(await geocodeFsa("L4K", { fetchImpl: attempt }), null, `attempt ${index}`);
  }
});

function counting(answers: Record<string, Point | null | "throw">) {
  const asked: string[] = [];
  const lookup = async (fsa: string): Promise<Point | null> => {
    asked.push(fsa);
    const answer = answers[fsa] ?? null;
    if (answer === "throw") throw new Error("down");
    return answer;
  };
  return { asked, lookup };
}

const here = { lat: 43.79, lng: -79.48 };

test("an area found once is not asked for again", async () => {
  const { asked, lookup } = counting({ L4K: here });
  const find = cachedLookup(lookup);
  assert.deepEqual(await find("L4K"), here);
  assert.deepEqual(await find("L4K"), here);
  assert.deepEqual(await find("L4K"), here);
  assert.deepEqual(asked, ["L4K"]);
});

test("two asks for the same area at once share one request", async () => {
  const { asked, lookup } = counting({ L4K: here });
  const find = cachedLookup(lookup);
  const [a, b] = await Promise.all([find("L4K"), find("L4K")]);
  assert.deepEqual([a, b], [here, here]);
  assert.deepEqual(asked, ["L4K"]);
});

test("not found is remembered briefly, then asked again", async () => {
  let clock = 0;
  const { asked, lookup } = counting({ L4K: null });
  const find = cachedLookup(lookup, { missMs: 60_000, now: () => clock });
  assert.equal(await find("L4K"), null);
  clock = 59_000;
  assert.equal(await find("L4K"), null);
  assert.deepEqual(asked, ["L4K"], "a service that is down is not hammered");
  clock = 61_000;
  await find("L4K");
  assert.deepEqual(asked, ["L4K", "L4K"]);
});

test("an answer expires after its time", async () => {
  let clock = 0;
  const { asked, lookup } = counting({ L4K: here });
  const find = cachedLookup(lookup, { foundMs: 1000, now: () => clock });
  await find("L4K");
  clock = 999;
  await find("L4K");
  assert.equal(asked.length, 1);
  clock = 1001;
  await find("L4K");
  assert.equal(asked.length, 2);
});

test("a lookup that throws is a miss, not an error", async () => {
  const { lookup } = counting({ L4K: "throw" });
  assert.equal(await cachedLookup(lookup)("L4K"), null);
});

test("the oldest areas go first when it is full", async () => {
  const { asked, lookup } = counting({ L4K: here, M3J: here, R3N: here });
  const find = cachedLookup(lookup, { maxEntries: 2 });
  await find("L4K");
  await find("M3J");
  await find("R3N"); // pushes L4K out
  await find("M3J");
  await find("R3N");
  assert.deepEqual(asked, ["L4K", "M3J", "R3N"]);
  await find("L4K");
  assert.deepEqual(asked, ["L4K", "M3J", "R3N", "L4K"]);
});
