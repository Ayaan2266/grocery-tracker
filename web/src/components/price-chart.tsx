"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { chartPoints, isoDay, spanOn, type Span } from "@/lib/history";

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  spans: Span[];
  /** The listing the page is about: drawn thicker, and its deals are shown in the tooltip. */
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

/**
 * Price over time, one step line per store. Steps rather than slopes: a price
 * holds until the day it changes, and a slope would invent the prices between.
 */
export function PriceChart({ series }: { series: ChartSeries[] }) {
  const points = chartPoints(series.map(({ key, spans }) => ({ key, spans })));
  if (points.length === 0) return null;

  const firstDay = points[0].day;
  const lastDay = points[points.length - 1].day;
  const prices = series.flatMap((s) => s.spans.map((span) => span.price_cents));
  const axis = priceAxis(Math.min(...prices), Math.max(...prices));

  return (
    <div className="price-chart" role="img" aria-label={`Price history from ${shortDate(firstDay)} to ${shortDate(lastDay)}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 12, right: 18, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#d8e3fa" strokeDasharray="3 5" vertical={false} />
          <XAxis
            dataKey="day"
            type="number"
            domain={[firstDay, lastDay === firstDay ? firstDay + 1 : lastDay]}
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
          <Tooltip content={<HistoryTooltip series={series} />} />
          {series.length > 1 && (
            <Legend
              iconType="plainline"
              itemSorter={null}
              wrapperStyle={{ fontSize: 13, paddingTop: 6 }}
            />
          )}
          {series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.label}
              type="stepAfter"
              stroke={s.color}
              strokeWidth={s.primary ? 3.5 : 2}
              dot={{ r: s.primary ? 3.5 : 2.5, fill: s.color, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
