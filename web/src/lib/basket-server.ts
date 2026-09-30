import { cookies } from "next/headers";
import { BASKET_COOKIE, parseBasket, type Basket } from "./basket";

export async function readBasket(): Promise<Basket> {
  const store = await cookies();
  return parseBasket(store.get(BASKET_COOKIE)?.value);
}
