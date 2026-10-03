/**
 * Canadian postal codes, and how far apart two places are.
 *
 * No imports, so `npm test` can run it on plain Node without a bundler.
 *
 * A visitor gives a postal code and the site shows the stores near it. Only the
 * first three characters, the forward sortation area (FSA, "L4K"), are ever
 * used: an FSA is a neighbourhood, not a home, and it is all the precision the
 * lookup has. Nothing longer is sent anywhere or stored.
 *
 * A place is a point, and an FSA's point is its centre, so a distance from one
 * is good to a few kilometres at best. That is plenty for "which of these stores
 * is near me", and the site says "about" when it shows one.
 */

export type Point = { lat: number; lng: number };

/** The radii a visitor can pick, in kilometres. */
export const NEAR_RADII = [10, 25, 50, 100] as const;
export const DEFAULT_NEAR_RADIUS = 25;

export function parseRadius(value: unknown): number {
  const km = Number(value);
  return (NEAR_RADII as readonly number[]).includes(km) ? km : DEFAULT_NEAR_RADIUS;
}

// Canada Post leaves out D, F, I, O, Q and U everywhere, and W and Z as a
// first letter. The second letter (the one after the digit) may be W or Z.
const POSTAL = /^([ABCEGHJ-NPRSTVXY])(\d)([ABCEGHJ-NPRSTV-Z])(?:[\s-]?(\d)([ABCEGHJ-NPRSTV-Z])(\d))?$/i;

/**
 * The FSA of what a visitor typed, or null when it is not a Canadian postal
 * code: "L4K", "l4k 0c1", "L4K-0C1" and "L4K0C1" all give "L4K". Only three or
 * six characters are accepted, so "L4K 0" is a typo rather than an FSA.
 */
export function parsePostalCode(input: string): string | null {
  const match = POSTAL.exec(input.trim());
  return match ? `${match[1]}${match[2]}${match[3]}`.toUpperCase() : null;
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance. Only used to order stores and bound a radius, so a sphere will do. */
export function distanceKm(a: Point, b: Point): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** A visitor's chosen place, as the cookie holds it. */
export type NearMe = { fsa: string; lat: number; lng: number; radiusKm: number };

/** "L4K|43.7947|-79.4812|25". Coordinates to four places, about ten metres. */
export function encodeNear(near: NearMe): string {
  return [near.fsa, near.lat.toFixed(4), near.lng.toFixed(4), String(near.radiusKm)].join("|");
}

/** The inverse of encodeNear; null for anything missing, tampered with or out of range. */
export function decodeNear(value: string | null | undefined): NearMe | null {
  const parts = (value ?? "").split("|");
  if (parts.length !== 4) return null;
  const [fsa, lat, lng, radius] = parts;
  if (parsePostalCode(fsa) !== fsa) return null;
  const point = { lat: Number(lat), lng: Number(lng) };
  if (!inCanada(point)) return null;
  const radiusKm = Number(radius);
  if (!(NEAR_RADII as readonly number[]).includes(radiusKm)) return null;
  return { fsa, ...point, radiusKm };
}

/** A box around Canada, to refuse a lookup that answered with somewhere else entirely. */
export function inCanada(point: Point): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= 41.5 &&
    point.lat <= 84 &&
    point.lng >= -142 &&
    point.lng <= -52
  );
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Where an FSA is: zippopotam.us, which needs no key and answers by FSA. */
export const GEOCODER_URL = "https://api.zippopotam.us/ca/";

export type GeocodeOptions = {
  /** For tests. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Any service that answers `<baseUrl><FSA>` in zippopotam.us's shape. */
  baseUrl?: string;
};

/**
 * The centre of an FSA, or null when it cannot be found or the lookup fails.
 * Never throws: a lookup that is down must not break a page, so every failure
 * reads as "not found", and callers say so rather than guess.
 *
 * The response is read defensively because it is a third party's: a place's
 * coordinates arrive as strings, and one that is missing, not a number, or not
 * in Canada is no answer.
 */
export async function geocodeFsa(
  fsa: string,
  { fetchImpl = fetch, timeoutMs = 4000, baseUrl = GEOCODER_URL }: GeocodeOptions = {},
): Promise<Point | null> {
  if (parsePostalCode(fsa) !== fsa) return null;
  try {
    const response = await fetchImpl(`${baseUrl}${fsa}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const places = (body as { places?: unknown })?.places;
    if (!Array.isArray(places) || places.length === 0) return null;
    const place = places[0] as { latitude?: unknown; longitude?: unknown };
    const point = { lat: Number(place.latitude), lng: Number(place.longitude) };
    return inCanada(point) ? point : null;
  } catch {
    return null;
  }
}

export type FsaLookup = (fsa: string) => Promise<Point | null>;

export type CacheOptions = {
  /** How long an answer is kept: an FSA does not move. */
  foundMs?: number;
  /** How long "not found" is kept, so a service that is down is not asked again by every page view. */
  missMs?: number;
  /** Most areas held at once; the oldest goes first. */
  maxEntries?: number;
  now?: () => number;
};

/**
 * `lookup` with a memory. A store's area is looked up on every page view that
 * shows stores near a visitor, and without this each view would ask the service
 * about every store. Asking for an area already being looked up shares that one
 * request, and a lookup that throws is a miss like any other.
 */
export function cachedLookup(
  lookup: FsaLookup,
  {
    foundMs = 30 * 24 * 60 * 60 * 1000,
    missMs = 60 * 1000,
    maxEntries = 500,
    now = Date.now,
  }: CacheOptions = {},
): FsaLookup {
  const kept = new Map<string, { point: Point | null; until: number }>();
  const asking = new Map<string, Promise<Point | null>>();
  return async (fsa) => {
    const known = kept.get(fsa);
    if (known && known.until > now()) return known.point;
    const pending = asking.get(fsa);
    if (pending) return pending;
    const request = lookup(fsa)
      .catch(() => null)
      .then((point) => {
        kept.delete(fsa);
        kept.set(fsa, { point, until: now() + (point ? foundMs : missMs) });
        while (kept.size > maxEntries) kept.delete(kept.keys().next().value as string);
        return point;
      })
      .finally(() => asking.delete(fsa));
    asking.set(fsa, request);
    return request;
  };
}
