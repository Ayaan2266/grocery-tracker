import Link from "next/link";

import { BasketButton } from "@/components/basket-button";
import type { LatestPrice } from "@/lib/queries";
import { bannerLabel } from "@/lib/stores";
import { formatCents, formatDay, formatUnitPrice } from "@/lib/utils";

/** The regular price behind a deal the store did not declare as a sale. */
export function estimatedRegular(row: LatestPrice): number | null {
  return row.was_price_cents === null ? (row.implied_regular_cents ?? null) : null;
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
}: {
  row: LatestPrice;
  href: string;
  quantity: number;
  id?: string;
}) {
  const estimated = estimatedRegular(row);
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
      </div>
      <div className="price-row-store">
        <strong>{bannerLabel(row.banner_slug, row.retailer_name)}</strong>
        <span>Recorded {formatDay(row.observed_on)}</span>
        <BasketButton productId={row.product_id} quantity={quantity} size="small" />
      </div>
      <div className="price-row-amount">
        <strong>{formatCents(row.price_cents)}</strong>
        {row.was_price_cents !== null && (
          <span className="sale-label">Store sale · was {formatCents(row.was_price_cents)}</span>
        )}
        {estimated !== null && (
          <span
            className="estimate-label"
            title="Estimated from the store's own unit price. The store does not mark this as a sale."
          >
            Usually ~{formatCents(estimated)}*
          </span>
        )}
        {unitPrice && <span>{unitPrice}</span>}
        {!row.in_stock && <span className="stock-label">Out of stock</span>}
      </div>
    </li>
  );
}
