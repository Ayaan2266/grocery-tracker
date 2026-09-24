"use client";

import { useId, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  chartPoints,
  dayNumber,
  isoDay,
  latestDeal,
  latestSpan,
  spanOn,
  windowSpans,
  type Span,
} from "@/lib/history";

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  spans: Span[];
  /** Latest recorded price, shown in the legend. */
  current?: number;
  /** The listing the page is about: drawn on top with a shaded area, and labelled "Latest". */
  primary?: boolean;
};

const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
const dollars = (cents: number) => money.format(cents / 100);
const shortDate = (day: number) =>
  new Date(`${isoDay(day)}T00:00:00Z`).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** Range tabs. A tab only shows once there is more history than it covers. */
const RANGES = [
  { label: "1W", days: 7, name: "Last week" },
  { label: "1M", days: 30, name: "Last month" },
  { label: "3M", days: 91, name: "Last three months" },
  { label: "All", days: null, name: "All history" },
] as const;
type RangeLabel = (typeof RANGES)[number]["label"];

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

/** Whole-day ticks, at most `max` of them, always including both ends. */
function dayTicks(first: number, last: number, max = 7): number[] {
  const span = last - first;
  if (span <= 0) return [first];
  const step = Math.max(1, Math.ceil(span / (max - 1)));
  const ticks: number[] = [];
  for (let day = first; day < last; day += step) ticks.push(day);
  ticks.push(last);
  return ticks;
}

type TooltipEntry = { dataKey?: string | number; value?: number | null; color?: string };

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
  return (
    <div className="chart-tooltip">
      <strong>{shortDate(label)}</strong>
      {series.map((s) => {
        const entry = payload.find((p) => p.dataKey === s.key);
        if (entry?.value == null) return null;
        const span = spanOn(s.spans, label);
        const regular = span?.was_price_cents ?? span?.implied_regular_cents ?? null;
        return (
          <span key={s.key}>
            <i style={{ background: s.color }} aria-hidden="true" />
            {s.label}: {dollars(entry.value)}
            {regular !== null && regular > entry.value && (
              <em>
                {span?.was_price_cents != null ? " sale, was " : " usually ~"}
                {dollars(regular)}
              </em>
            )}
          </span>
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

type DealTag = { key: string; day: number; price: number; text: string; align: "start" | "middle" | "end" };

/**
 * Price over time, one step line per store. Steps rather than slopes: a price
 * holds until the day it changes, and a slope would invent the prices between.
 */
export function PriceChart({
  series,
  titleId,
  subtitle,
}: {
  series: ChartSeries[];
  titleId: string;
  subtitle: string;
}) {
  const [range, setRange] = useState<RangeLabel>("All");
  const gradientId = `area-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const allDays = series.flatMap((s) =>
    s.spans.flatMap((span) => [dayNumber(span.first_observed_on), dayNumber(span.last_confirmed_on)]),
  );
  const header = (tabs: typeof RANGES[number][], active: RangeLabel | null) => (
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
  const historyDays = historyEnd - Math.min(...allDays) + 1;
  const tabs = RANGES.filter((r) => r.days === null || historyDays > r.days);
  const active = tabs.find((t) => t.label === range) ?? tabs[tabs.length - 1];

  const endIso = isoDay(historyEnd);
  const shown = series
    .map((s) => ({ ...s, spans: active.days === null ? s.spans : windowSpans(s.spans, endIso, active.days) }))
    .filter((s) => s.spans.length > 0);
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

  // Tag the latest deal on the primary line first, then one other store's, if they are apart.
  const tags: DealTag[] = [];
  for (const s of [...shown].sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false))) {
    const deal = latestDeal(s.spans);
    if (!deal) continue;
    const day = Math.round(
      (dayNumber(deal.span.first_observed_on) + dayNumber(deal.span.last_confirmed_on)) / 2,
    );
    const at = position(day);
    if (tags.some((t) => Math.abs(position(t.day) - at) < 0.3) || tags.length === 2) continue;
    const prefix = shown.length > 1 ? `${s.label} ` : "";
    const words = deal.declared ? `sale · was ${dollars(deal.regular)}` : `usually ~${dollars(deal.regular)}`;
    const text = prefix ? prefix + words : words[0].toUpperCase() + words.slice(1);
    tags.push({ key: s.key, day, price: deal.span.price_cents, text, align: at > 0.75 ? "end" : at < 0.25 ? "start" : "middle" });
  }

  // A series seen on a single day in view has no line to draw, so it gets a dot.
  const pointCount = (key: string) => points.filter((p) => p[key] != null).length;
  const drawOrder = [...shown].sort((a, b) => Number(a.primary ?? false) - Number(b.primary ?? false));

  return (
    <>
      {header(tabs, active.label)}
      <ul className="chart-legend">
        {series.map((s) => (
          <li key={s.key}>
            <i style={{ background: s.color }} aria-hidden="true" />
            <strong>{s.label}</strong>
            {s.current !== undefined && <span>{dollars(s.current)}</span>}
          </li>
        ))}
      </ul>
      <div
        className="price-chart"
        role="img"
        aria-label={`Price history from ${shortDate(firstDay)} to ${shortDate(lastDay)}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 22, right: 18, bottom: 4, left: 4 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={primary?.color ?? "#0b49bd"} stopOpacity={0.24} />
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
              tickLine={false}
              axisLine={{ stroke: "#d8e3fa" }}
            />
            <YAxis
              domain={axis.domain}
              ticks={axis.ticks}
              tickFormatter={(cents: number) => dollars(cents)}
              tick={{ fill: "#53617e", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={62}
            />
            <Tooltip content={<HistoryTooltip series={shown} />} />
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
            {drawOrder.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="stepAfter"
                stroke={s.color}
                strokeWidth={s.primary ? 3 : 2}
                dot={pointCount(s.key) === 1 ? { r: 4, fill: s.color, strokeWidth: 0 } : false}
                activeDot={{ r: 5, strokeWidth: 2, stroke: "#fff" }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
            {tags.map((tag) => (
              <ReferenceDot
                key={`deal-${tag.key}`}
                x={tag.day}
                y={tag.price}
                r={0}
                label={<Callout text={tag.text} align={tag.align} below fill="#fff0a7" color="#10224c" />}
              />
            ))}
            {primary && primaryLatest && (
              <ReferenceDot
                x={dayNumber(primaryLatest.last_confirmed_on)}
                y={primaryLatest.price_cents}
                r={5}
                fill={primary.color}
                stroke="#fff"
                strokeWidth={2}
                label={
                  <Callout
                    text={`Latest ${dollars(primaryLatest.price_cents)}`}
                    align={position(dayNumber(primaryLatest.last_confirmed_on)) < 0.25 ? "start" : "end"}
                    fill="#10224c"
                    color="#fff"
                  />
                }
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
