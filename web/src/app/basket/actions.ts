"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import {
  BASKET_COOKIE,
  MAX_ITEMS,
  MAX_QUANTITY,
  parseBasket,
  serializeBasket,
  type Basket,
} from "@/lib/basket";

async function update(change: (basket: Basket) => void): Promise<void> {
  const store = await cookies();
  const basket = parseBasket(store.get(BASKET_COOKIE)?.value);
  change(basket);
  store.set(BASKET_COOKIE, serializeBasket(basket), {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 90,
  });
  // Every page shows the basket count in its header.
  revalidatePath("/", "layout");
}

function productId(form: FormData): number | null {
  const id = Number(form.get("productId"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function addToBasket(form: FormData): Promise<void> {
  const id = productId(form);
  if (id === null) return;
  await update((basket) => {
    if (!basket.has(id) && basket.size >= MAX_ITEMS) return;
    basket.set(id, Math.min((basket.get(id) ?? 0) + 1, MAX_QUANTITY));
  });
}

export async function changeQuantity(form: FormData): Promise<void> {
  const id = productId(form);
  const delta = Number(form.get("delta"));
  if (id === null || !Number.isInteger(delta)) return;
  await update((basket) => {
    const next = (basket.get(id) ?? 0) + delta;
    if (next <= 0) basket.delete(id);
    else basket.set(id, Math.min(next, MAX_QUANTITY));
  });
}

export async function removeFromBasket(form: FormData): Promise<void> {
  const id = productId(form);
  if (id === null) return;
  await update((basket) => {
    basket.delete(id);
  });
}

export async function clearBasket(): Promise<void> {
  await update((basket) => basket.clear());
}
