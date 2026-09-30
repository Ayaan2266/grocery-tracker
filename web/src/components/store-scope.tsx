import { setStoreScope } from "@/app/stores/actions";
import type { ScopedStores } from "@/lib/store-scope";
import { BANNER_COLORS, storeName, type StoreScope } from "@/lib/stores";

const list = new Intl.ListFormat("en-CA", { type: "conjunction" });

/**
 * Ontario or every store, as a segmented control matching the sort toggle. One
 * form with two submit buttons posting to a server action, like the basket
 * buttons, so it works with JavaScript off. Renders nothing unless there are
 * stores both in and outside Ontario, since otherwise there is no choice.
 */
export function StoreScopeControl({ scoped }: { scoped: ScopedStores }) {
  const { scope, counts } = scoped;
  if (counts.outside === 0 || counts.ontario === 0) return null;
  const options: { value: StoreScope; label: string; count: number }[] = [
    { value: "ontario", label: "Ontario", count: counts.ontario },
    { value: "all", label: "All stores", count: counts.ontario + counts.outside },
  ];
  return (
    <form action={setStoreScope} className="scope-toggle" aria-label="Stores to show">
      {options.map((option) => (
        <button
          key={option.value}
          type="submit"
          name="scope"
          value={option.value}
          aria-pressed={scope === option.value}
        >
          {option.label}
          <span className="scope-count">
            {option.count}
            <span className="visually-hidden"> stores</span>
          </span>
        </button>
      ))}
    </form>
  );
}

/**
 * What the current choice leaves out, or brings in, in one line. "results"
 * sits under prices; "home" explains where the choice applies.
 */
export function storeScopeHelp(scoped: ScopedStores, where: "results" | "home"): string | null {
  const { scope, counts, stores, storeIds } = scoped;
  if (counts.outside === 0 || counts.ontario === 0) return null;
  if (where === "home") {
    return scope === "all"
      ? "Search, product pages and the basket show every store."
      : "Search, product pages and the basket show the Ontario stores.";
  }
  if (scope === "all") {
    return `Includes ${counts.outside} store${counts.outside === 1 ? "" : "s"} outside Ontario, where prices and even brands follow their region.`;
  }
  const outside = stores.filter((store) => storeIds !== null && !storeIds.includes(store.id));
  const names = list.format(outside.map((s) => storeName(s.banner_slug, s.retailer_name, s.label)));
  return `${names} ${outside.length === 1 ? "is" : "are"} checked nightly too, but ${outside.length === 1 ? "it is" : "they are"} outside Ontario.`;
}

/** The control with its line beside it, for the basket, product page and home page. */
export function StoreScopeRow({ scoped, where }: { scoped: ScopedStores; where: "results" | "home" }) {
  const help = storeScopeHelp(scoped, where);
  if (help === null) return null;
  return (
    <div className="scope-row">
      <StoreScopeControl scoped={scoped} />
      <p className="scope-help">{help}</p>
    </div>
  );
}

/**
 * A banner's colour as a dot: filled for its first store, a ring for any other
 * store of the same banner, so two Superstores never look like one.
 */
export function StoreDot({
  slug,
  ring = false,
  as: Tag = "span",
  className = "store-dot",
}: {
  slug: string;
  ring?: boolean;
  as?: "span" | "i";
  className?: string;
}) {
  const color = BANNER_COLORS[slug] ?? "#53617e";
  return (
    <Tag
      className={[className, ring ? "is-ring" : ""].filter(Boolean).join(" ") || undefined}
      style={ring ? { borderColor: color } : { background: color }}
      aria-hidden="true"
    />
  );
}
