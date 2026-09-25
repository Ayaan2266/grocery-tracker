import Link from "next/link";

import { BasketButton } from "@/components/basket-button";
import { Sparkline } from "@/components/sparkline";
import type { Badge } from "@/lib/history";
import type { LatestPrice } from "@/lib/queries";
import { BANNER_COLORS, bannerLabel, storeArea } from "@/lib/stores";
import { formatCents, formatDay, formatUnitPrice } from "@/lib/utils";

/** The regular price behind a deal the store did not declare as a sale. */
export function estimatedRegular(row: LatestPrice): number | null {
  return row.was_price_cents === null ? (row.implied_regular_cents ?? null) : null;
}

/** Whole-percent saving against a regular price, or null when there is none. */
export function percentOff(price: number, regular: number | null): number | null {
  if (regular === null || regular <= price) return null;
  return Math.round(((regular - price) / regular) * 100);
}

/** The store a price was recorded at: banner, and where that store is. */
export function StoreChip({ row }: { row: LatestPrice }) {
  const area = storeArea(row.store_label);
  return (
    <span className="store-chip" title={`Recorded ${formatDay(row.observed_on)}`}>
      <i style={{ background: BANNER_COLORS[row.banner_slug] ?? "#53617e" }} aria-hidden="true" />
      {bannerLabel(row.banner_slug, row.retailer_name)}
      {area && <span className="store-chip-area">{area}</span>}
    </span>
  );
}

/**
 * One store listing. The product name is a link stretched over the whole row,
 * so the row is one big target, while the basket button stays its own target
 * on top of it.
 */
export function PriceRow({
  row,
  href,
  quantity,
  id,
  trend,
  badge,
}: {
  row: LatestPrice;
  href: string;
  quantity: number;
  id?: string;
  /** The last few days' prices, oldest first; null for a day it was not seen. */
  trend?: (number | null)[];
  badge?: Badge | null;
}) {
  const estimated = estimatedRegular(row);
  const off = percentOff(row.price_cents, row.was_price_cents ?? estimated);
  const unitPrice = formatUnitPrice(
    row.unit_price_cents,
    row.comparison_quantity,
    row.comparison_unit,
  );

  return (
    <li className="price-row" id={id}>
      <div className="price-row-product">
        <h3>
          <Link href={href} className="price-row-link">
            {row.raw_name}
          </Link>
        </h3>
        <p>{[row.brand, row.package_size].filter(Boolean).join(" · ") || "Grocery item"}</p>
        <div className="price-row-chips">
          <StoreChip row={row} />
          {badge && <span className={`status-badge status-${badge.tone}`}>{badge.label}</span>}
          {!row.in_stock && <span className="status-badge status-bad">Out of stock</span>}
        </div>
      </div>
      <div className="price-row-trend" aria-hidden={trend ? undefined : true}>
        {trend && (
          <>
            <Sparkline values={trend} color={BANNER_COLORS[row.banner_slug] ?? "#53617e"} />
            <small>Last {trend.length} days</small>
          </>
        )}
      </div>
      <div className="price-row-amount">
        <strong>{formatCents(row.price_cents)}</strong>
        {row.was_price_cents !== null && (
          <span className="deal-tag deal-sale">
            Store sale · was {formatCents(row.was_price_cents)}
          </span>
        )}
        {estimated !== null && (
          <span
            className="deal-tag deal-usual"
            title="Estimated from the store's own unit price. The store does not mark this as a sale."
          >
            Usually ~{formatCents(estimated)}*{off !== null && ` · ${off}% off`}
          </span>
        )}
        {unitPrice && <span>{unitPrice}</span>}
      </div>
      <div className="price-row-action">
        <BasketButton productId={row.product_id} quantity={quantity} size="small" />
      </div>
    </li>
  );
}
