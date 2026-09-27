/**
 * The aisles the nightly check searches, in ingest/targets.json's order, each
 * with one of its own search terms to try on the site.
 *
 * No imports, so `npm test` can run it on plain Node. aisles.test.ts reads
 * targets.json and fails if this list, a sample or the term count drifts
 * from what the ingest actually searches.
 */
export const AISLES: { key: string; label: string; sample: string }[] = [
  { key: "dairy_and_eggs", label: "Dairy & eggs", sample: "large eggs" },
  { key: "bakery", label: "Bakery", sample: "bagels" },
  { key: "produce", label: "Produce", sample: "bananas" },
  { key: "meat_and_seafood", label: "Meat & seafood", sample: "chicken breast" },
  { key: "pantry", label: "Pantry", sample: "olive oil" },
  { key: "frozen", label: "Frozen", sample: "ice cream" },
  { key: "beverages", label: "Drinks", sample: "orange juice" },
  { key: "snacks", label: "Snacks", sample: "popcorn" },
  { key: "household_and_baby", label: "Household & baby", sample: "paper towels" },
  { key: "other", label: "Everything else", sample: "hummus" },
];

/** Distinct search terms across every aisle. */
export const SEARCH_TERM_COUNT = 167;
