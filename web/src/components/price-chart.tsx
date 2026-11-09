"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, X } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  usePlotArea,
  useYAxisScale,
} from "recharts";

import {
  CHART_DEFAULT_LINES,
  CHART_MAX_LINES,
  biggestDrop,
  chartPoints,
  dayNumber,
  isoDay,
  latestDeal,
  latestSpan,
  rangeStats,
  spanOn,
  suggestedLines,
  windowSpans,
  type Span,
} from "@/lib/history";
import { markDot, storeMark } from "@/lib/stores";
import { formatCents, formatDay } from "@/lib/utils";

export type ChartSeries = {
  key: string;
  /** The store's name wherever there is room for one string: the tooltip. */
  label: string;
  /** The chain's short name and the store's place, for the chips: "Loblaws", "Markham Bullock Drive". */
  banner: string;
  place: string | null;
  /** The chain, for one line per chain by default and the dropdown's groups. */
  group: string;
  groupName: string;
  color: string;
  spans: Span[];
  /** Latest recorded price. */
  current?: number;
  /** The listing the page is about: always drawn, on top, with a shaded area. */
  primary?: boolean;
  /**
   * Which of its banner's stores this is, as an index into STORE_MARKS: the
   * same colour with its own dashes, so a chain's stores stay apart without a
   * colour outside the checked set.
   */
  mark?: number;
};

/** "Oct 2", for a day number: the graph's x axis counts in days. */
const shortDate = (day: number) => formatDay(isoDay(day));
const longDate = (day: number) =>
  new Date(`${isoDay(day)}T00:00:00Z`).toLocaleDateString("en-CA", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
/** "Oct 2", or "Sep 24 – Oct 1" for a stretch. */
const stretch = (from: string, to: string) => (from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`);

/** Range tabs. A tab only shows once there is more history than it covers. */
const RANGES = [
  { label: "7D", days: 7, name: "Last 7 days", word: "7 days" },
  { label: "30D", days: 30, name: "Last 30 days", word: "30 days" },
  { label: "90D", days: 90, name: "Last 90 days", word: "90 days" },
  { label: "1Y", days: 365, name: "Last year", word: "1 year" },
  { label: "All", days: null, name: "All history", word: null },
] as const;
type Range = (typeof RANGES)[number];
type RangeLabel = Range["label"];

/**
 * A price axis on round amounts: steps of 25c, 50c, $1 or $2 depending on the
 * spread, with a little room above and below the data.
 */
function priceAxis(low: number, high: number): { domain: [number, number]; ticks: number[] } {
  const spread = Math.max(high - low, 1);
  const step = [25, 50, 100, 200, 500].find((s) => spread / s <= 4) ?? 1000;
  const bottom = Math.max(0, Math.floor((low - step / 2) / step) * step);
  const top = Math.ceil((high + step / 2) / step) * step;
  const ticks: number[] = [];
  for (let cents = bottom; cents <= top; cents += step) ticks.push(cents);
  return { domain: [bottom, top], ticks };
}

/**
 * Whole-day ticks, at most `max` of them, always including both ends. A tick
 * less than half a step before the last one is dropped, so the final two
 * dates ("Nov 3", "Nov 6") never print on top of each other.
 */
function dayTicks(first: number, last: number, max = 7): number[] {
  const span = last - first;
  if (span <= 0) return [first];
  const step = Math.max(1, Math.ceil(span / (max - 1)));
  const ticks: number[] = [];
  for (let day = first; day < last; day += step) ticks.push(day);
  if (ticks.length > 1 && last - ticks[ticks.length - 1] < step / 2) ticks.pop();
  ticks.push(last);
  return ticks;
}

/** True on a phone-width screen, where the line-end labels have no room. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(max-width: 600px)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(max-width: 600px)").matches,
    () => false,
  );
}

function Dot({ s, as: Tag = "i" }: { s: ChartSeries; as?: "i" | "span" }) {
  const dot = markDot(s.color, s.mark);
  return <Tag className={["chart-dot", dot.className].filter(Boolean).join(" ")} style={dot.style} aria-hidden="true" />;
}

/** Stores at one price, cheapest group first. */
function byPrice<T extends { price: number }>(rows: T[]): { price: number; rows: T[] }[] {
  const groups = new Map<number, T[]>();
  for (const row of rows) groups.set(row.price, [...(groups.get(row.price) ?? []), row]);
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([price, rows]) => ({ price, rows }));
}

type TooltipEntry = { dataKey?: string | number; value?: number | null };

/**
 * Every store drawn, grouped by price and cheapest first, so a line hidden
 * under another at the same price is still named.
 */
function HistoryTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: number;
  series: ChartSeries[];
}) {
  if (!active || !payload?.length || label === undefined) return null;
  const rows = series.flatMap((s) => {
    const price = payload.find((p) => p.dataKey === s.key)?.value;
    return price == null ? [] : [{ s, price, span: spanOn(s.spans, label) }];
  });
  if (rows.length === 0) return null;
  const groups = byPrice(rows);
  const cheapest = groups[0].price;
  return (
    <div className="chart-tooltip">
      <strong>{longDate(label)}</strong>
      {groups.map((group, i) => {
        const many = group.rows.length > 1;
        const tag = rows.length > 1 && i === 0 ? (many ? `Cheapest · ${group.rows.length} stores` : "Cheapest") : many ? `${group.rows.length} stores` : null;
        return (
          <div key={group.price} className="tip-group">
            <div className="tip-head">
              {tag ? <span className={i === 0 ? "tip-cheapest" : undefined}>{tag}</span> : <span />}
              <span>
                {i > 0 && <em className="tip-gap">+{formatCents(group.price - cheapest)}</em>}
                <b>{formatCents(group.price)}</b>
              </span>
            </div>
            {group.rows.map(({ s, span, price }) => {
              const regular = span?.was_price_cents ?? span?.implied_regular_cents ?? null;
              return (
                <span key={s.key} className="tip-store">
                  <Dot s={s} />
                  {s.label}
                  {s.primary && " (this)"}
                  {regular !== null && regular > price && (
                    <em>
                      {span?.was_price_cents != null ? " sale, was " : " usually ~"}
                      {formatCents(regular)}
                    </em>
                  )}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

type LabelViewBox = { x?: number; y?: number; width?: number; height?: number };

/**
 * A pill of text pinned to a point on the graph. Recharts hands it the point's
 * box; `align` says which side of the point the pill extends to.
 */
function Callout({
  viewBox,
  text,
  align,
  below = false,
  fill,
  color,
}: {
  viewBox?: LabelViewBox;
  text: string;
  align: "start" | "middle" | "end";
  below?: boolean;
  fill: string;
  color: string;
}) {
  if (!viewBox) return null;
  const cx = (viewBox.x ?? 0) + (viewBox.width ?? 0) / 2;
  const cy = (viewBox.y ?? 0) + (viewBox.height ?? 0) / 2;
  const width = Math.round(text.length * 6.7 + 20);
  const height = 24;
  const left = align === "end" ? cx - width + 10 : align === "start" ? cx - 10 : cx - width / 2;
  const top = below ? cy + 8 : cy - height - 10;
  return (
    <g className="chart-callout">
      <rect x={left} y={top} width={width} height={height} rx={12} fill={fill} />
      <text x={left + width / 2} y={top + 16} textAnchor="middle" fill={color} fontSize={12} fontWeight={800}>
        {text}
      </text>
    </g>
  );
}

type EndLabel = { price: number; text: string; color: string; mark?: number };
const END_LABEL_HEIGHT = 24;
const endLabelWidth = (text: string) => Math.round(text.length * 6.9 + 34);

/**
 * One label per price where the lines end, in the margin right of the graph:
 * "$1.25 · 3 stores" says three lines sit on top of each other there. Labels
 * closer than their own height are pushed apart, then pulled back up if that
 * runs them off the bottom.
 */
function EndLabels({ labels }: { labels: EndLabel[] }) {
  const scale = useYAxisScale();
  const area = usePlotArea();
  if (!scale || !area) return null;
  const gap = 4;
  const placed = labels
    .map((label) => ({ ...label, y: scale(label.price) ?? 0 }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < placed.length; i += 1) {
    placed[i].y = Math.max(placed[i].y, placed[i - 1].y + END_LABEL_HEIGHT + gap);
  }
  const overflow = placed.length ? placed[placed.length - 1].y + END_LABEL_HEIGHT / 2 - (area.y + area.height + 6) : 0;
  if (overflow > 0) for (const p of placed) p.y -= overflow;
  const x = area.x + area.width + 12;
  return (
    <g className="chart-end-labels">
      {placed.map((p) => {
        const dash = storeMark(p.mark).dash;
        return (
          <g key={p.price}>
            <rect
              x={x}
              y={p.y - END_LABEL_HEIGHT / 2}
              width={endLabelWidth(p.text)}
              height={END_LABEL_HEIGHT}
              rx={12}
              fill="#fff"
              stroke={p.color}
              strokeWidth={1.5}
            />
            <circle cx={x + 13} cy={p.y} r={4.5} fill={dash ? "#fff" : p.color} stroke={p.color} strokeWidth={dash ? 2 : 0} />
            <text x={x + 24} y={p.y + 4} fill="#10224c" fontSize={12} fontWeight={800}>
              {p.text}
            </text>
          </g>
        );
      })}
    </g>
  );
}

type Tone = "dark" | "good" | "bad" | "plain";

function Stat({ label, value, note, tone, noteTone = "plain" }: { label: string; value: string; note: string; tone: Tone; noteTone?: Tone }) {
  return (
    <div className={`chart-stat chart-stat-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small className={`chart-stat-note-${noteTone}`}>{note}</small>
    </div>
  );
}

/**
 * The stores on the graph as chips, which double as its legend, and a menu of
 * every store that carries the item, grouped by chain, to tick lines on and off.
 */
function StorePicker({
  series,
  shown,
  isSuggested,
  onChange,
  onReset,
}: {
  series: ChartSeries[];
  shown: string[];
  isSuggested: boolean;
  onChange: (keys: string[]) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = `${useId()}-stores`;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = series.filter((s) => shown.includes(s.key));
  const hidden = series.length - visible.length;
  const full = visible.length >= CHART_MAX_LINES;
  const toggle = (key: string) =>
    onChange(shown.includes(key) ? shown.filter((k) => k !== key) : series.filter((s) => s.key === key || shown.includes(s.key)).map((s) => s.key));
  const groups = [...Map.groupBy(series, (s) => s.group).values()];

  return (
    <div className="store-picker" ref={wrapRef}>
      <span className="store-picker-label">Stores</span>
      <ul className="store-chips" aria-label="Stores on the graph">
        {visible.map((s) => (
          <li key={s.key} className="store-chip" style={{ borderColor: s.color }}>
            <Dot s={s} />
            <strong>{s.banner}</strong>
            {s.place && <span className="store-chip-place">{s.place}</span>}
            {s.current !== undefined && <b>{formatCents(s.current)}</b>}
            {s.primary ? (
              <small>This listing</small>
            ) : (
              <button type="button" aria-label={`Hide ${s.label} from the graph`} onClick={() => toggle(s.key)}>
                <X size={14} strokeWidth={2.6} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {series.length > 1 && (
        <button
          ref={buttonRef}
          type="button"
          className="store-picker-more"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen(!open)}
        >
          {hidden > 0 ? `+${hidden} more store${hidden === 1 ? "" : "s"}` : "Choose stores"}
          <ChevronDown size={15} strokeWidth={2.6} aria-hidden="true" />
        </button>
      )}
      {open && (
        <div className="store-menu" id={menuId} role="group" aria-label="Stores on the graph">
          <p className="store-menu-title">Stores on the graph</p>
          <p className="store-menu-hint">This listing always shows. Up to {CHART_MAX_LINES} stores at once.</p>
          {groups.map((group) => (
            <fieldset key={group[0].group}>
              <legend>
                <Dot s={{ ...group[0], mark: 0 }} />
                {group[0].groupName}
              </legend>
              {group.map((s) => {
                const on = shown.includes(s.key);
                return (
                  <label key={s.key} className={on ? "is-on" : undefined}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={s.primary || (!on && full)}
                      onChange={() => toggle(s.key)}
                    />
                    <span>
                      {s.place ?? s.banner}
                      {s.primary && <small> (this listing)</small>}
                    </span>
                    {s.current !== undefined && <b>{formatCents(s.current)}</b>}
                  </label>
                );
              })}
            </fieldset>
          ))}
          <div className="store-menu-footer">
            <button type="button" className="store-menu-reset" disabled={isSuggested} onClick={onReset}>
              Reset to suggested
            </button>
            <button
              type="button"
              className="store-menu-done"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type DealTag = { day: number; price: number; text: string; align: "start" | "middle" | "end" };

/**
 * Price over time, one step line per store. Steps rather than slopes: a price
 * holds until the day it changes, and a slope would invent the prices between.
 */
export function PriceChart({
  series,
  titleId,
  nearby = false,
}: {
  series: ChartSeries[];
  titleId: string;
  /** The stores were narrowed to the ones near the reader: the subtitle says so. */
  nearby?: boolean;
}) {
  const [range, setRange] = useState<RangeLabel>("All");
  const [picked, setPicked] = useState<string[] | null>(null);
  const narrow = useNarrow();
  const gradientId = `area-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const suggested = suggestedLines(series, CHART_DEFAULT_LINES);
  const shownKeys = picked ?? suggested;
  const allDays = series.flatMap((s) =>
    s.spans.flatMap((span) => [dayNumber(span.first_observed_on), dayNumber(span.last_confirmed_on)]),
  );
  const subtitle =
    series.length > 1
      ? `${series.length} ${nearby ? "nearby " : ""}stores carry this item · hover or tap the graph for any day`
      : "Hover or tap the graph for the price on any day";

  const header = (tabs: Range[], active: RangeLabel | null) => (
    <div className="chart-header">
      <div>
        <h2 id={titleId}>Price history</h2>
        <p>{subtitle}</p>
      </div>
      {active && tabs.length > 1 && (
        <div className="range-tabs" role="group" aria-label="Time range">
          {tabs.map((tab) => (
            <button
              key={tab.label}
              type="button"
              aria-pressed={tab.label === active}
              aria-label={tab.name}
              onClick={() => setRange(tab.label)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  if (allDays.length === 0) return header([], null);

  const historyEnd = Math.max(...allDays);
  const historyStart = Math.min(...allDays);
  const historyDays = historyEnd - historyStart + 1;
  const tabs = RANGES.filter((r) => r.days === null || historyDays > r.days);
  const active = tabs.find((t) => t.label === range) ?? tabs[tabs.length - 1];

  const endIso = isoDay(historyEnd);
  const inRange = (s: ChartSeries) => ({
    ...s,
    spans: active.days === null ? s.spans : windowSpans(s.spans, endIso, active.days),
  });
  const shown = series
    .filter((s) => shownKeys.includes(s.key))
    .map(inRange)
    .filter((s) => s.spans.length > 0);
  if (shown.length === 0) return header(tabs, active.label);
  const points = chartPoints(shown.map(({ key, spans }) => ({ key, spans })));

  const firstDay = points[0].day;
  const lastDay = points[points.length - 1].day;
  const prices = shown.flatMap((s) => s.spans.map((span) => span.price_cents));
  const axis = priceAxis(Math.min(...prices), Math.max(...prices));
  // A single day is drawn in the middle of a three-day axis, not against its edge.
  const domain: [number, number] = lastDay === firstDay ? [firstDay - 1, lastDay + 1] : [firstDay, lastDay];
  const position = (day: number) => (day - domain[0]) / (domain[1] - domain[0]);

  const primary = shown.find((s) => s.primary);
  const primaryLatest = primary ? latestSpan(primary.spans) : undefined;
  const stats = primary ? rangeStats(primary.spans) : null;
  const now = primary?.current ?? stats?.current;
  const rangeWord = active.word ? ` · ${active.word}` : ` since ${shortDate(historyStart)}`;

  // One callout on the page's own line: its latest sale if it has one, else its biggest drop.
  let tag: DealTag | null = null;
  if (primary) {
    const deal = latestDeal(primary.spans);
    const drop = deal ? null : biggestDrop(primary.spans);
    if (deal) {
      const day = Math.round((dayNumber(deal.span.first_observed_on) + dayNumber(deal.span.last_confirmed_on)) / 2);
      const words = deal.declared ? `Sale · was ${formatCents(deal.regular)}` : `Usually ~${formatCents(deal.regular)}`;
      tag = { day, price: deal.span.price_cents, text: words, align: "middle" };
    } else if (drop) {
      tag = { day: dayNumber(drop.day), price: drop.to, text: `Dropped ${formatCents(drop.from - drop.to)} on ${formatDay(drop.day)}`, align: "start" };
    }
    if (tag) {
      const at = position(tag.day);
      tag.align = at > 0.7 ? "end" : at < 0.3 ? "start" : "middle";
    }
  }

  // Where each line ends, grouped by price: stacked lines are named here.
  const ends = byPrice(
    shown.flatMap((s) => {
      const last = latestSpan(s.spans);
      return last ? [{ s, price: last.price_cents }] : [];
    }),
  ).map(({ price, rows }): EndLabel => {
    const lead = rows.find((r) => r.s.primary) ?? rows[0];
    return {
      price,
      text: rows.length > 1 ? `${formatCents(price)} · ${rows.length} stores` : `${formatCents(price)} · ${lead.s.banner}`,
      color: lead.s.color,
      mark: lead.s.mark,
    };
  });
  const showEnds = !narrow && shown.length > 1;
  const rightMargin = showEnds ? Math.max(...ends.map((e) => endLabelWidth(e.text))) + 20 : 18;

  // A series seen on a single day in view has no line to draw, so it gets a dot.
  const pointCount = (key: string) => points.filter((p) => p[key] != null).length;
  const drawOrder = [...shown].sort((a, b) => Number(a.primary ?? false) - Number(b.primary ?? false));
  const showAverage = stats !== null && stats.lowest !== stats.highest;

  return (
    <>
      {header(tabs, active.label)}

      {stats && now !== undefined && primary && (
        <div className="chart-stats">
          <Stat
            label="Now"
            value={formatCents(now)}
            note={`${[primary.banner, primary.place].filter(Boolean).join(" · ")} (this listing)`}
            tone="dark"
          />
          <Stat
            label={`Lowest${rangeWord}`}
            value={formatCents(stats.lowest)}
            note={
              stats.lowest === stats.highest
                ? "No change in this range"
                : now <= stats.lowest
                  ? `At its lowest now, since ${formatDay(stats.lowestFrom)}`
                  : stretch(stats.lowestFrom, stats.lowestTo)
            }
            tone={now <= stats.lowest && stats.lowest !== stats.highest ? "good" : "plain"}
            noteTone={now <= stats.lowest && stats.lowest !== stats.highest ? "good" : "plain"}
          />
          <Stat
            label={`Average${rangeWord}`}
            value={formatCents(stats.average)}
            note={
              now < stats.average
                ? `${formatCents(stats.average - now)} below average`
                : now > stats.average
                  ? `${formatCents(now - stats.average)} above average`
                  : "Right on average"
            }
            tone="plain"
            noteTone={now < stats.average ? "good" : now > stats.average ? "bad" : "plain"}
          />
          <Stat
            label={`Highest${rangeWord}`}
            value={formatCents(stats.highest)}
            note={stats.lowest === stats.highest ? "No change in this range" : stretch(stats.highestFrom, stats.highestTo)}
            tone="plain"
          />
        </div>
      )}

      <StorePicker
        series={series}
        shown={shownKeys}
        isSuggested={picked === null}
        onChange={setPicked}
        onReset={() => setPicked(null)}
      />

      <div
        className="price-chart"
        role="img"
        aria-label={`Price history from ${shortDate(firstDay)} to ${shortDate(lastDay)}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 22, right: rightMargin, bottom: 4, left: 4 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={primary?.color ?? "#0b49bd"} stopOpacity={0.2} />
                <stop offset="100%" stopColor={primary?.color ?? "#0b49bd"} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#e3ebfb" vertical={false} />
            <XAxis
              dataKey="day"
              type="number"
              domain={domain}
              ticks={dayTicks(firstDay, lastDay)}
              tickFormatter={shortDate}
              tick={{ fill: "#53617e", fontSize: 12 }}
              tickMargin={8}
              tickLine={false}
              axisLine={{ stroke: "#d8e3fa" }}
            />
            <YAxis
              domain={axis.domain}
              ticks={axis.ticks}
              tickFormatter={(cents: number) => formatCents(cents)}
              tick={{ fill: "#53617e", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={62}
            />
            <Tooltip
              content={<HistoryTooltip series={shown} />}
              cursor={{ stroke: "#10224c", strokeOpacity: 0.3, strokeWidth: 1 }}
            />
            {primary && (
              <Area
                dataKey={primary.key}
                type="stepAfter"
                stroke="none"
                fill={`url(#${gradientId})`}
                baseValue="dataMin"
                connectNulls
                dot={false}
                activeDot={false}
                tooltipType="none"
                isAnimationActive={false}
              />
            )}
            {showAverage && (
              <ReferenceLine
                y={stats.average}
                stroke="#53617e"
                strokeDasharray="5 5"
                strokeWidth={1.25}
                label={
                  narrow
                    ? undefined
                    : { value: `avg ${formatCents(stats.average)}`, position: "insideTopLeft", fill: "#53617e", fontSize: 11, fontWeight: 800 }
                }
              />
            )}
            {drawOrder.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="stepAfter"
                stroke={s.color}
                strokeWidth={s.primary ? 3.5 : 2}
                strokeDasharray={storeMark(s.mark).dash ?? undefined}
                dot={pointCount(s.key) === 1 ? { r: 4, fill: s.color, strokeWidth: 0 } : false}
                activeDot={{ r: 5, strokeWidth: 2, stroke: "#fff" }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
            {tag && (
              <ReferenceDot
                x={tag.day}
                y={tag.price}
                r={0}
                label={<Callout text={tag.text} align={tag.align} below fill="#fff0a7" color="#10224c" />}
              />
            )}
            {showEnds &&
              shown
                .filter((s) => !s.primary)
                .map((s) => {
                  const last = latestSpan(s.spans);
                  return last ? (
                    <ReferenceDot
                      key={`end-${s.key}`}
                      x={dayNumber(last.last_confirmed_on)}
                      y={last.price_cents}
                      r={4}
                      fill={s.color}
                      stroke="#fff"
                      strokeWidth={2}
                    />
                  ) : null;
                })}
            {primary && primaryLatest && (
              <ReferenceDot
                x={dayNumber(primaryLatest.last_confirmed_on)}
                y={primaryLatest.price_cents}
                r={5.5}
                fill={primary.color}
                stroke="#fff"
                strokeWidth={2.5}
                label={
                  showEnds ? undefined : (
                    <Callout
                      text={`Latest ${formatCents(primaryLatest.price_cents)}`}
                      align={position(dayNumber(primaryLatest.last_confirmed_on)) < 0.25 ? "start" : "end"}
                      fill="#10224c"
                      color="#fff"
                    />
                  )
                }
              />
            )}
            {showEnds && <EndLabels labels={ends} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
