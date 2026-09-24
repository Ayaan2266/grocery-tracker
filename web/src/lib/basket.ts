import { cookies } from "next/headers";

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
    const [id, qty] = part.split(":").map(Number);
    if (Number.isInteger(id) && id > 0 && Number.isInteger(qty) && qty > 0) {
      basket.set(id, Math.min(qty, MAX_QUANTITY));
    }
    if (basket.size >= MAX_ITEMS) break;
  }
  return basket;
}

export function serializeBasket(basket: Basket): string {
  return [...basket].map(([id, qty]) => `${id}:${qty}`).join(",");
}

export async function readBasket(): Promise<Basket> {
  const store = await cookies();
  return parseBasket(store.get(BASKET_COOKIE)?.value);
}
