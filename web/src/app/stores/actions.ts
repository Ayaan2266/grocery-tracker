"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { STORE_SCOPE_COOKIE } from "@/lib/store-scope";

export async function setStoreScope(form: FormData): Promise<void> {
  const store = await cookies();
  if (form.get("scope") === "all") {
    store.set(STORE_SCOPE_COOKIE, "all", {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 90,
    });
  } else {
    store.delete(STORE_SCOPE_COOKIE);
  }
  // Search results, product comparisons and basket totals all depend on it.
  revalidatePath("/", "layout");
}
