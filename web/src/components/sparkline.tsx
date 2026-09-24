import { formatCents } from "@/lib/utils";

/**
 * A tiny trend line, drawn as plain SVG on the server so search pages load
 * no charting code. Days a product was not seen break the line rather than
 * being drawn through, the same rule as the full graph.
 */
export function Sparkline({
  values,
  color,
  width = 112,
  height = 34,
}: {
  values: (number | null)[];
  color: string;
  width?: number;
  height?: number;
}) {
  const seen = values.filter((v): v is number => v !== null);
  if (seen.length === 0) return null;

  const low = Math.min(...seen);
  const high = Math.max(...seen);
  const pad = 4;
  const x = (i: number) => pad + (i / Math.max(values.length - 1, 1)) * (width - pad * 2);
  const y = (v: number) => (high === low ? height / 2 : pad + ((high - v) / (high - low)) * (height - pad * 2));

  let path = "";
  let drawing = false;
  values.forEach((v, i) => {
    if (v === null) {
      drawing = false;
      return;
    }
    path += `${drawing ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    drawing = true;
  });
  const lastIndex = values.findLastIndex((v) => v !== null);
  const last = values[lastIndex] as number;
  const first = seen[0];
  const trend = last < first ? "down" : last > first ? "up" : "steady";

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Last ${values.length} days: ${trend === "steady" ? `steady at ${formatCents(last)}` : `${trend} from ${formatCents(first)} to ${formatCents(last)}`}`}
    >
      <path d={path.trim()} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(lastIndex)} cy={y(last)} r={3.5} fill={color} />
    </svg>
  );
}
