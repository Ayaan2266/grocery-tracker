/** Display names and graph colours for each banner, keyed by banner_slug. */
export const BANNER_LABELS: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Real Canadian Superstore",
  loblaw: "Loblaws",
};

/** Short names for tight spots: graph legends and basket columns. */
export const BANNER_SHORT: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Superstore",
  loblaw: "Loblaws",
};

export const BANNER_COLORS: Record<string, string> = {
  nofrills: "#c99700",
  superstore: "#df2140",
  loblaw: "#0b49bd",
};

export function bannerLabel(slug: string, fallback: string): string {
  return BANNER_LABELS[slug] ?? fallback;
}
