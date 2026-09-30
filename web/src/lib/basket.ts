import { parseProductId } from "./product-id.ts";

/**
 * The basket lives in a cookie: "12:1,40:2" is product 12 once and product 40
 * twice. A cookie rather than localStorage because the server renders every
 * page, so the header count, the "In basket" buttons and the basket page all
 * come out right on the first paint, and adding works as a plain form post
 * with JavaScript off, like the search box.
 */
export const BASKET_COOKIE = "loonie_basket";
export const MAX_ITEMS = 100;
export const MAX_QUANTITY = 99;

export type Basket = Map<number, number>;

export function parseBasket(raw: string | undefined): Basket {
  const basket: Basket = new Map();
  for (const part of (raw ?? "").split(",")) {
    const parts = part.split(":");
    if (parts.length !== 2) continue;
    const id = parseProductId(parts[0]);
    const qty = Number(parts[1]);
    if (id !== null && /^\d+$/.test(parts[1]) && Number.isSafeInteger(qty) && qty > 0) {
      basket.set(id, Math.min(qty, MAX_QUANTITY));
    }
    if (basket.size >= MAX_ITEMS) break;
  }
  return basket;
}

export function serializeBasket(basket: Basket): string {
  return [...basket].map(([id, qty]) => `${id}:${qty}`).join(",");
}

/** Quantity controls only adjust an existing line, one item at a time. */
export function adjustQuantity(basket: Basket, id: number, delta: number): void {
  const quantity = basket.get(id);
  if (quantity === undefined || (delta !== -1 && delta !== 1)) return;
  const next = quantity + delta;
  if (next <= 0) basket.delete(id);
  else basket.set(id, Math.min(next, MAX_QUANTITY));
}
