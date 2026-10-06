"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import {
  BASKET_COOKIE,
  MAX_ITEMS,
  MAX_QUANTITY,
  adjustQuantity,
  parseBasket,
  serializeBasket,
  type Basket,
} from "@/lib/basket";
import { parseProductId } from "@/lib/product-id";

async function update(change: (basket: Basket) => void): Promise<void> {
  const store = await cookies();
  const basket = parseBasket(store.get(BASKET_COOKIE)?.value);
  change(basket);
  store.set(BASKET_COOKIE, serializeBasket(basket), {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    // HTTPS only once deployed; `next dev` serves plain http://localhost.
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 90,
  });
  // Every page shows the basket count in its header.
  revalidatePath("/", "layout");
}

export async function addToBasket(form: FormData): Promise<void> {
  const id = parseProductId(form.get("productId"));
  if (id === null) return;
  await update((basket) => {
    if (!basket.has(id) && basket.size >= MAX_ITEMS) return;
    basket.set(id, Math.min((basket.get(id) ?? 0) + 1, MAX_QUANTITY));
  });
}

export async function changeQuantity(form: FormData): Promise<void> {
  const id = parseProductId(form.get("productId"));
  const delta = Number(form.get("delta"));
  if (id === null || (delta !== -1 && delta !== 1)) return;
  await update((basket) => adjustQuantity(basket, id, delta));
}

export async function removeFromBasket(form: FormData): Promise<void> {
  const id = parseProductId(form.get("productId"));
  if (id === null) return;
  await update((basket) => {
    basket.delete(id);
  });
}

export async function clearBasket(): Promise<void> {
  await update((basket) => basket.clear());
}
