import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";

import { BasketButton } from "@/components/basket-button";
import { ProductPhoto } from "@/components/product-photo";
import { StoreChip } from "@/components/price-row";
import { changeReason, changeSpoken, changeText, isWeighed, type PriceChange } from "@/lib/changes";
import { formatCents } from "@/lib/utils";

/**
 * One listing whose price moved overnight: last night's price struck through,
 * tonight's, and how far it moved. Laid out like a search result, with the
 * product name stretched over the row as its link and the basket button on
 * top of it.
 */
export function ChangeRow({
  change,
  quantity,
  mark,
  id,
}: {
  change: PriceChange;
  quantity: number;
  mark?: number;
  id?: string;
}) {
  const down = change.change_cents < 0;
  const reason = changeReason(change);
  const weighed = isWeighed(change);
  return (
    <li className={down ? "change-row is-down" : "change-row is-up"} id={id}>
      <div className="change-row-product">
        <ProductPhoto url={change.image_url} variant="thumb" />
        <div className="row-text">
          <h3>
            <Link href={`/product/${change.product_id}`} className="price-row-link">
              {change.raw_name}
            </Link>
          </h3>
          <p>
            {[change.brand, weighed ? "Sold by weight" : change.package_size].filter(Boolean).join(" · ") ||
              "Grocery item"}
          </p>
          <div className="price-row-chips">
            <StoreChip row={{ ...change, observed_on: change.changed_on }} mark={mark} />
            {reason === "sale-started" && change.was_price_cents !== null && (
              <span className="status-badge status-good">Sale · was {formatCents(change.was_price_cents)}</span>
            )}
            {reason === "sale-ended" && <span className="status-badge status-neutral">Sale ended</span>}
          </div>
        </div>
      </div>
      <div className="change-row-amount">
        <s><span className="visually-hidden">Was </span>{formatCents(change.previous_price_cents)}</s>
        <strong><span className="visually-hidden">Now </span>{formatCents(change.price_cents)}</strong>
        {weighed && <small className="change-row-unit">per piece, est.</small>}
        <span className="change-badge">
          {down ? <ArrowDown size={13} strokeWidth={3} aria-hidden="true" /> : <ArrowUp size={13} strokeWidth={3} aria-hidden="true" />}
          <span aria-hidden="true">{changeText(change)}</span>
          <span className="visually-hidden">{changeSpoken(change)}</span>
        </span>
      </div>
      <div className="price-row-action">
        <BasketButton productId={change.product_id} quantity={quantity} size="small" />
      </div>
    </li>
  );
}
