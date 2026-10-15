/**
 * The price-changes page: every shelf price that moved on each store's latest
 * nightly run, from the price_changes view (db/migrations/0016). Pure helpers
 * here; the queries are in queries.ts.
 */

/** One listing whose shelf price moved since its store's previous run. */
export type PriceChange = {
  product_id: number;
  retailer_sku: string;
  raw_name: string;
  brand: string | null;
  package_size: string | null;
  store_id: number;
  store_code: string;
  store_label: string | null;
  banner_slug: string;
  retailer_name: string;
  /** The run the new price was first seen on. */
  changed_on: string;
  previous_run_on: string;
  previous_price_cents: number;
  price_cents: number;
  /** New minus old: negative is a drop. */
  change_cents: number;
  /** Rounded to one decimal by the database. PostgREST sends NUMERIC as a number or a string. */
  change_percent: number | string;
  previous_was_price_cents: number | null;
  was_price_cents: number | null;
  implied_regular_cents: number | null;
};

/** One store's tally for the night it last ran. */
export type PriceChangeCount = {
  store_id: number;
  changed_on: string;
  drops: number;
  rises: number;
};

export type Direction = "down" | "up";

export function parseDirection(raw: string | undefined): Direction {
  return raw === "up" ? "up" : "down";
}

/**
 * The store filter, only when it names a store the page is showing. A stale
 * or hand-typed id falls back to every store in scope rather than an empty
 * page.
 */
export function parseStoreFilter(raw: string | undefined, allowed: number[]): number | null {
  if (!raw || !/^[1-9]\d{0,8}$/.test(raw)) return null;
  const id = Number(raw);
  return allowed.includes(id) ? id : null;
}

/**
 * The night the page reports: the newest run any store has a change on. A
 * store whose last run is older is left out rather than shown as if its old
 * news were overnight.
 */
export function latestChangeDay(counts: PriceChangeCount[]): string | null {
  return counts.reduce<string | null>((latest, c) => (latest === null || c.changed_on > latest ? c.changed_on : latest), null);
}

export type Tally = {
  drops: number;
  rises: number;
  /** Per store, for the store chips. */
  byStore: Map<number, { drops: number; rises: number }>;
};

/** Drops and rises on `day` at the stores in scope (null for every store). */
export function tally(counts: PriceChangeCount[], day: string | null, storeIds: number[] | null): Tally {
  const byStore = new Map<number, { drops: number; rises: number }>();
  let drops = 0;
  let rises = 0;
  for (const c of counts) {
    if (c.changed_on !== day) continue;
    if (storeIds !== null && !storeIds.includes(c.store_id)) continue;
    byStore.set(c.store_id, { drops: c.drops, rises: c.rises });
    drops += c.drops;
    rises += c.rises;
  }
  return { drops, rises, byStore };
}

const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });

/** The size of a percentage change, no sign: whole percent from 1% up, one decimal below. */
export function percentText(percent: number | string): string {
  const value = Math.abs(Number(percent));
  return value >= 1 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}

/** "$2.50 · 31%", the size of a change without its direction. */
export function changeText(change: Pick<PriceChange, "change_cents" | "change_percent">): string {
  return `${money.format(Math.abs(change.change_cents) / 100)} · ${percentText(change.change_percent)}`;
}

/** "down $2.50, 31%": the same for a screen reader, with the direction in words. */
export function changeSpoken(change: Pick<PriceChange, "change_cents" | "change_percent">): string {
  const direction = change.change_cents < 0 ? "down" : "up";
  return `${direction} ${money.format(Math.abs(change.change_cents) / 100)}, ${percentText(change.change_percent)}`;
}

/**
 * Why the price moved, when the store says: a sale starting (it now shows a
 * regular price) or a sale ending (it showed one last night and not tonight).
 * Null when the store gives no reason.
 */
export function changeReason(change: Pick<PriceChange, "was_price_cents" | "previous_was_price_cents" | "change_cents">):
  | "sale-started"
  | "sale-ended"
  | null {
  if (change.change_cents < 0 && change.was_price_cents !== null) return "sale-started";
  if (change.change_cents > 0 && change.previous_was_price_cents !== null && change.was_price_cents === null) {
    return "sale-ended";
  }
  return null;
}

/** "Thursday, October 15", for a YYYY-MM-DD day, read as a calendar date. */
export function dayHeading(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-CA", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Most weekly flyers start on Thursday, so the run that night has by far the
 * most changes (README, "Storage growth": 9,711 shelf prices on one Thursday
 * against 116 the night before).
 */
export function isFlyerNight(iso: string): boolean {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 4;
}

/** The page's own address with its filters, for tabs, chips and "Show more". */
export function changesHref({
  direction,
  store,
  count,
}: {
  direction: Direction;
  store: number | null;
  count?: number;
}): string {
  const params = new URLSearchParams();
  if (direction === "up") params.set("dir", "up");
  if (store !== null) params.set("store", String(store));
  if (count !== undefined) params.set("n", String(count));
  const query = params.toString();
  return query ? `/changes?${query}` : "/changes";
}
