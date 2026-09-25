/** Display names and graph colours for each banner, keyed by banner_slug. */
export const BANNER_LABELS: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Real Canadian Superstore",
  loblaw: "Loblaws",
  zehrs: "Zehrs",
  fortinos: "Fortinos",
  maxi: "Maxi",
};

/** Short names for tight spots: graph legends and basket columns. */
export const BANNER_SHORT: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Superstore",
  loblaw: "Loblaws",
  zehrs: "Zehrs",
  fortinos: "Fortinos",
  maxi: "Maxi",
};

/**
 * One colour per banner, never reassigned, so a store keeps its colour on
 * every graph whichever others appear beside it. Checked as a set against the
 * white chart surface, every pair against every other, for colour-blind
 * separation: the closest pair is ΔE 7.9, which is only acceptable because
 * the legend, tooltip and store lists always name the store in text too.
 */
export const BANNER_COLORS: Record<string, string> = {
  nofrills: "#c99700",
  superstore: "#df2140",
  loblaw: "#0b49bd",
  zehrs: "#15803d",
  fortinos: "#b5479f",
  maxi: "#0ea5b7",
};

export function bannerLabel(slug: string, fallback: string): string {
  return BANNER_LABELS[slug] ?? fallback;
}

/**
 * Where a store is, from its label: "Real Canadian Superstore - Winnipeg
 * Kenaston" gives "Winnipeg Kenaston". Each banner is tracked at one store,
 * and they are far apart (Superstore's is in Winnipeg), so a price never
 * appears without the place it was recorded. Null for a label with no place.
 */
export function storeArea(label: string | null | undefined): string | null {
  if (!label) return null;
  const at = label.indexOf(" - ");
  const area = at === -1 ? "" : label.slice(at + 3).trim();
  return area || null;
}

/** "Superstore · Winnipeg Kenaston", or just the banner when the place is unknown. */
export function storeName(slug: string, fallback: string, label: string | null | undefined): string {
  const area = storeArea(label);
  const name = BANNER_SHORT[slug] ?? fallback;
  return area ? `${name} · ${area}` : name;
}
