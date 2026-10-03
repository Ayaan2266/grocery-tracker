"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { lookupFsa } from "@/lib/geocode";
import { encodeNear, parsePostalCode, parseRadius } from "@/lib/postal";
import { NEAR_COOKIE, STORE_SCOPE_COOKIE } from "@/lib/store-scope";

const COOKIE = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  maxAge: 60 * 60 * 24 * 90,
} as const;

/** Results, comparisons and basket totals all depend on the stores shown. */
function refresh(): void {
  revalidatePath("/", "layout");
}

/**
 * Ontario, every store, or the stores near the postal code given earlier.
 * "near" with no place saved is Ontario, and "forget" drops the place too.
 */
export async function setStoreScope(form: FormData): Promise<void> {
  const store = await cookies();
  const scope = form.get("scope");
  if (scope === "all") {
    store.set(STORE_SCOPE_COOKIE, "all", COOKIE);
  } else if (scope === "near" && store.get(NEAR_COOKIE)) {
    store.set(STORE_SCOPE_COOKIE, "near", COOKIE);
  } else {
    store.delete(STORE_SCOPE_COOKIE);
    if (scope === "forget") store.delete(NEAR_COOKIE);
  }
  refresh();
}

export type NearMeState = { error: string | null; postal: string };

/**
 * Save a postal code and radius and show the stores near it. Written for
 * useActionState, so the form still posts and the answer still comes back with
 * JavaScript off. Only the FSA is looked up and kept.
 */
export async function setNearMe(_previous: NearMeState, form: FormData): Promise<NearMeState> {
  const postal = String(form.get("postal") ?? "").trim().slice(0, 12);
  const fsa = parsePostalCode(postal);
  if (!fsa) {
    return { error: "That does not look like a Canadian postal code. Try L4K or L4K 0C1.", postal };
  }
  const point = await lookupFsa(fsa);
  if (!point) {
    return { error: `Could not find where ${fsa} is just now. Check it, or try again in a moment.`, postal };
  }
  const store = await cookies();
  store.set(NEAR_COOKIE, encodeNear({ fsa, ...point, radiusKm: parseRadius(form.get("radius")) }), COOKIE);
  store.set(STORE_SCOPE_COOKIE, "near", COOKIE);
  refresh();
  return { error: null, postal: "" };
}
