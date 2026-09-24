/**
 * Price-history maths for the product page: the graph's points and the "is
 * this a good price?" verdict.
 *
 * No imports, so `npm test` can run it on plain Node without a bundler.
 *
 * History arrives as spans (see db/migrations/0006): one row per unbroken
 * stretch of identical values, first_observed_on .. last_confirmed_on.
 */

export type Span = {
  first_observed_on: string;
  last_confirmed_on: string;
  price_cents: number;
  was_price_cents: number | null;
  implied_regular_cents?: number | null;
  in_stock: boolean;
};

const DAY_MS = 86_400_000;

/** Whole days since 1970-01-01 for an ISO date, in UTC. */
export function dayNumber(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/** The ISO date for a day number. */
export function isoDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function spanDays(span: Span): number {
  return dayNumber(span.last_confirmed_on) - dayNumber(span.first_observed_on) + 1;
}

export type VerdictKind = "new" | "steady" | "lowest" | "below" | "typical" | "above";

export type Verdict = {
  kind: VerdictKind;
  lowest: number;
  highest: number;
  /** The price it sat at for the most days: a day-weighted median. */
  typical: number;
  /** Calendar days from the first day seen to the last, inclusive. */
  daysTracked: number;
  since: string;
};

/**
 * How today's price compares with everything recorded for this listing.
 *
 * Weighted by days, so a price that held for three weeks counts for more
 * than a one-day blip. Returns null when there is no history at all.
 */
export function summarize(spans: Span[], current: number): Verdict | null {
  if (spans.length === 0) return null;

  const first = Math.min(...spans.map((s) => dayNumber(s.first_observed_on)));
  const last = Math.max(...spans.map((s) => dayNumber(s.last_confirmed_on)));
  const prices = spans.map((s) => s.price_cents);
  const lowest = Math.min(...prices);
  const highest = Math.max(...prices);

  const byPrice = [...spans].sort((a, b) => a.price_cents - b.price_cents);
  const total = byPrice.reduce((sum, s) => sum + spanDays(s), 0);
  let seen = 0;
  let typical = byPrice[0].price_cents;
  for (const span of byPrice) {
    seen += spanDays(span);
    if (seen * 2 >= total) {
      typical = span.price_cents;
      break;
    }
  }

  const daysTracked = last - first + 1;
  const base = { lowest, highest, typical, daysTracked, since: isoDay(first) };

  if (daysTracked < 2) return { kind: "new", ...base };
  if (lowest === highest) return { kind: "steady", ...base };
  if (current <= lowest) return { kind: "lowest", ...base };
  if (current < typical) return { kind: "below", ...base };
  if (current > typical) return { kind: "above", ...base };
  return { kind: "typical", ...base };
}

export type Series = { key: string; spans: Span[] };

export type ChartPoint = { day: number } & Record<string, number | null>;

/**
 * Points for a step graph with one line per series.
 *
 * Every span contributes its first and last day, so a price that held for a
 * fortnight draws as a flat line rather than a slope. At each of those days a
 * series has the price of the span covering it, or null when it was not seen
 * that day; the graph bridges nulls, so a day a product went unseen does not
 * break its line.
 */
export function chartPoints(series: Series[]): ChartPoint[] {
  const days = new Set<number>();
  for (const { spans } of series) {
    for (const span of spans) {
      days.add(dayNumber(span.first_observed_on));
      days.add(dayNumber(span.last_confirmed_on));
    }
  }

  return [...days]
    .sort((a, b) => a - b)
    .map((day) => {
      const point: ChartPoint = { day };
      for (const { key, spans } of series) {
        const covering = spans.find(
          (s) => dayNumber(s.first_observed_on) <= day && day <= dayNumber(s.last_confirmed_on),
        );
        point[key] = covering ? covering.price_cents : null;
      }
      return point;
    });
}

/** The span covering a day, for the graph's tooltip. */
export function spanOn(spans: Span[], day: number): Span | undefined {
  return spans.find(
    (s) => dayNumber(s.first_observed_on) <= day && day <= dayNumber(s.last_confirmed_on),
  );
}

/**
 * The spans covering the `days` days ending on `endIso`, clipped to that
 * window. Used for the search rows, which only fetch recent history.
 */
export function windowSpans(spans: Span[], endIso: string, days: number): Span[] {
  const end = dayNumber(endIso);
  const start = end - days + 1;
  return spans
    .filter((s) => dayNumber(s.last_confirmed_on) >= start && dayNumber(s.first_observed_on) <= end)
    .map((s) => ({
      ...s,
      first_observed_on: isoDay(Math.max(dayNumber(s.first_observed_on), start)),
      last_confirmed_on: isoDay(Math.min(dayNumber(s.last_confirmed_on), end)),
    }));
}

/**
 * One value per day for the `days` days ending on `endIso`: the price that
 * day, or null when the product was not seen. The input to a sparkline.
 */
export function dailyPrices(spans: Span[], endIso: string, days: number): (number | null)[] {
  const end = dayNumber(endIso);
  const out: (number | null)[] = [];
  for (let day = end - days + 1; day <= end; day += 1) {
    out.push(spanOn(spans, day)?.price_cents ?? null);
  }
  return out;
}

export type Badge = { label: string; tone: "good" | "neutral" | "bad" };

/** A one-line verdict for a search row, from recent history only. */
export function badgeFor(spans: Span[], current: number): Badge | null {
  const verdict = summarize(spans, current);
  if (!verdict) return null;
  switch (verdict.kind) {
    case "lowest":
      return { label: `Lowest in ${verdict.daysTracked} days`, tone: "good" };
    case "below":
      return { label: "Below typical", tone: "good" };
    case "above":
      return { label: "Above typical", tone: "bad" };
    case "steady":
      return { label: "Steady price", tone: "neutral" };
    default:
      return null;
  }
}

/** Where a price sits between low and high, as a percentage from 0 to 100. */
export function rangePercent(price: number, low: number, high: number): number {
  if (high <= low) return 50;
  return Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
}

/** The most recent span: the one today's price comes from. */
export function latestSpan(spans: Span[]): Span | undefined {
  let latest: Span | undefined;
  for (const span of spans) {
    if (!latest || span.last_confirmed_on > latest.last_confirmed_on) latest = span;
  }
  return latest;
}

export type Deal = {
  span: Span;
  regular: number;
  /** True when the store printed the regular price; false when it is inferred. */
  declared: boolean;
};

/** The most recent stretch sold below a regular price, for the graph's deal tag. */
export function latestDeal(spans: Span[]): Deal | null {
  let found: Deal | null = null;
  for (const span of spans) {
    const regular = span.was_price_cents ?? span.implied_regular_cents ?? null;
    if (regular === null || regular <= span.price_cents) continue;
    if (!found || span.last_confirmed_on > found.span.last_confirmed_on) {
      found = { span, regular, declared: span.was_price_cents !== null };
    }
  }
  return found;
}
