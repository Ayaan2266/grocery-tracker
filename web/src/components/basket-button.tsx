import { Check, Plus } from "lucide-react";
import Link from "next/link";

import { addToBasket } from "@/app/basket/actions";

/**
 * "Add to basket", or "In basket" once it is there. A form posting to a
 * server action, so it works with JavaScript off and the page re-renders with
 * the new count.
 */
export function BasketButton({
  productId,
  quantity,
  size = "normal",
}: {
  productId: number;
  quantity: number;
  size?: "normal" | "small";
}) {
  if (quantity > 0) {
    return (
      <Link href="/basket" className={`basket-button basket-button-added basket-button-${size}`}>
        <Check size={16} aria-hidden="true" />
        {size === "small" ? "Added" : "In basket"}
        {quantity > 1 ? ` (${quantity})` : ""}
      </Link>
    );
  }
  return (
    <form action={addToBasket} className="basket-form">
      <input type="hidden" name="productId" value={productId} />
      <button
        type="submit"
        className={`basket-button basket-button-${size}`}
        aria-label={size === "small" ? "Add to basket" : undefined}
      >
        <Plus size={16} aria-hidden="true" />
        {size === "small" ? "Add" : "Add to basket"}
      </button>
    </form>
  );
}
