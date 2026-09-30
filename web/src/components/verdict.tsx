import { rangePercent, type Verdict } from "@/lib/history";
import { formatCents, formatDay } from "@/lib/utils";

/**
 * The verdict in words and as a bar. Shared by the product page and the How
 * it works page, so the explanation can never disagree with the real thing.
 */
export function verdictText(verdict: Verdict): { headline: string; detail: string } {
  const since = formatDay(verdict.since);
  switch (verdict.kind) {
    case "new":
      return {
        headline: "Just started tracking",
        detail: `First recorded ${since}. The graph fills in as prices are checked each night.`,
      };
    case "steady":
      return {
        headline: "Same price each time checked",
        detail: `It has been ${formatCents(verdict.lowest)} each time recorded since ${since}.`,
      };
    case "lowest":
      return {
        headline: "Lowest price recorded",
        detail: `Nothing cheaper since ${since}. Its typical price is ${formatCents(verdict.typical)}.`,
      };
    case "below":
      return {
        headline: "Below its typical price",
        detail: `It usually sells for ${formatCents(verdict.typical)} here.`,
      };
    case "above":
      return {
        headline: "Above its typical price",
        detail: `It usually sells for ${formatCents(verdict.typical)} here. It has been as low as ${formatCents(verdict.lowest)}.`,
      };
    default:
      return {
        headline: "Its typical price",
        detail: `It has ranged from ${formatCents(verdict.lowest)} to ${formatCents(verdict.highest)} since ${since}.`,
      };
  }
}

/**
 * Lowest to highest recorded price, with the stretch below typical in green,
 * typical marked in yellow, and a marker where today's price sits.
 */
export function RangeBar({ verdict, price }: { verdict: Verdict; price: number }) {
  const { lowest, typical, highest } = verdict;
  const typicalAt = rangePercent(typical, lowest, highest);
  const todayAt = rangePercent(price, lowest, highest);
  const tone =
    verdict.kind === "lowest" || verdict.kind === "below" ? "good" : verdict.kind === "above" ? "bad" : "neutral";
  return (
    <div
      className="range-bar"
      role="img"
      aria-label={`${formatCents(price)} today, against a low of ${formatCents(lowest)}, a typical ${formatCents(typical)} and a high of ${formatCents(highest)}`}
    >
      <span className="range-today" style={{ left: `${todayAt}%`, transform: `translateX(-${todayAt}%)` }}>
        Latest {formatCents(price)}
      </span>
      <div className="range-track">
        <span className="range-good" style={{ width: `${typicalAt}%` }} />
        <span className="range-typical" style={{ left: `clamp(0%, calc(${typicalAt}% - 6%), 88%)` }} />
        <span className={`range-marker range-marker-${tone}`} style={{ left: `${todayAt}%` }} />
      </div>
      <div className="range-labels" aria-hidden="true">
        <span>Low {formatCents(lowest)}</span>
        <span>Typical {formatCents(typical)}</span>
        <span>High {formatCents(highest)}</span>
      </div>
    </div>
  );
}
