import { ArrowRight, Search } from "lucide-react";

/**
 * A plain GET form: it works before JavaScript loads, and every search is a
 * shareable URL. `compact` is the smaller version in the header of inner pages.
 */
export function SearchForm({ query = "", compact = false }: { query?: string; compact?: boolean }) {
  return (
    <form
      action="/#prices"
      method="get"
      role="search"
      className={compact ? "search-form search-form-compact" : "search-form"}
    >
      <Search size={compact ? 20 : 25} strokeWidth={2} aria-hidden="true" />
      <input
        type="search"
        name="q"
        defaultValue={query}
        placeholder="Search milk, cheddar, bananas..."
        aria-label="Search grocery prices"
        enterKeyHint="search"
      />
      <button type="submit" aria-label="Search prices">
        <span>Search prices</span>
        <ArrowRight size={compact ? 18 : 21} aria-hidden="true" />
      </button>
    </form>
  );
}
