import Form from "next/form";
import { ArrowRight, Search } from "lucide-react";

/**
 * A GET form: every search is a shareable URL, and it works before JavaScript
 * loads. Once it has, next/form turns the submit into a client-side navigation,
 * so a search fetches only the new results instead of reloading the whole page.
 * `compact` is the smaller version in the header of inner pages.
 */
export function SearchForm({ query = "", compact = false }: { query?: string; compact?: boolean }) {
  return (
    <Form
      action="/#prices"
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
        maxLength={100}
      />
      <button type="submit" aria-label="Search prices">
        <span>Search prices</span>
        <ArrowRight size={compact ? 18 : 21} aria-hidden="true" />
      </button>
    </Form>
  );
}
