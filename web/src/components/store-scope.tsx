import { NearMeForm } from "@/components/near-me-form";
import { setStoreScope } from "@/app/stores/actions";
import { DEFAULT_NEAR_RADIUS } from "@/lib/postal";
import type { ScopedStores } from "@/lib/store-scope";
import { BANNER_COLORS, storeName, type StoreScope } from "@/lib/stores";

const list = new Intl.ListFormat("en-CA", { type: "conjunction" });

/** Whether there is a choice to make between Ontario and every store. */
function hasRegions(scoped: ScopedStores): boolean {
  return scoped.counts.outside > 0 && scoped.counts.ontario > 0;
}

/**
 * Ontario, every store and, once a postal code is saved, the stores near it, as
 * a segmented control matching the sort toggle. One form with a submit button
 * per choice posting to a server action, like the basket buttons, so it works
 * with JavaScript off. Renders nothing when there is no choice: all stores in
 * one region, and no place saved.
 */
export function StoreScopeControl({ scoped }: { scoped: ScopedStores }) {
  const { scope, counts, near, nearStores } = scoped;
  if (!hasRegions(scoped) && !near) return null;
  const options: { value: StoreScope; label: string; count: number }[] = [];
  if (hasRegions(scoped)) {
    options.push({ value: "ontario", label: "Ontario", count: counts.ontario });
  }
  if (near && nearStores) {
    options.push({ value: "near", label: `Near ${near.fsa}`, count: nearStores.ids.length });
  }
  options.push({ value: "all", label: "All stores", count: counts.ontario + counts.outside });
  // With every store in one region Ontario and "all" are the same set, so there
  // is no Ontario button and "all" stands for both.
  const pressed = (value: StoreScope) =>
    scope === value || (!hasRegions(scoped) && scope === "ontario" && value === "all");
  return (
    <form action={setStoreScope} className="scope-toggle" aria-label="Stores to show">
      {options.map((option) => (
        <button
          key={option.value}
          type="submit"
          name="scope"
          value={option.value}
          aria-pressed={pressed(option.value)}
        >
          {option.label}
          <span className="scope-count">
            {option.count}
            <span className="visually-hidden"> {option.count === 1 ? "store" : "stores"}</span>
          </span>
        </button>
      ))}
    </form>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The stores near the visitor and how far, nearest first: "Zehrs · Uxbridge (about 41 km)". */
function nearList(scoped: ScopedStores): string {
  const { stores, nearStores, storeIds } = scoped;
  if (!nearStores) return "";
  const shown = stores
    .filter((store) => storeIds?.includes(store.id) ?? true)
    .sort((a, b) => (nearStores.km.get(a.id) ?? Infinity) - (nearStores.km.get(b.id) ?? Infinity));
  return list.format(
    shown.map((store) => {
      const name = storeName(store.banner_slug, store.retailer_name, store.label);
      const km = nearStores.km.get(store.id);
      return km === undefined ? name : `${name} (about ${Math.max(1, Math.round(km))} km)`;
    }),
  );
}

/** What "near" shows, in a sentence: how many stores, and how far each is. */
function nearHelp(scoped: ScopedStores, where: "results" | "home"): string | null {
  const { near, nearStores, storeIds } = scoped;
  if (!near || !nearStores) return null;
  if (where === "home") return `Search, product pages and the basket show the stores near ${near.fsa}.`;
  const shown = storeIds?.length ?? scoped.stores.length;
  if (nearStores.widened) {
    return `No store is within ${near.radiusKm} km of ${near.fsa}, so this shows the nearest: ${nearList(scoped)}.`;
  }
  const unplaced = nearStores.unplaced.length;
  const unplacedNote =
    unplaced > 0
      ? ` ${plural(unplaced, "store")} could not be placed on the map just now, so ${unplaced === 1 ? "it is" : "they are"} shown too.`
      : "";
  return `Showing ${plural(shown, "store")} within ${near.radiusKm} km of ${near.fsa}: ${nearList(scoped)}.${unplacedNote}`;
}

/**
 * What the current choice leaves out, or brings in, in one line. "results"
 * sits under prices; "home" explains where the choice applies.
 */
export function storeScopeHelp(scoped: ScopedStores, where: "results" | "home"): string | null {
  const { scope, counts, stores, storeIds } = scoped;
  if (scope === "near") return nearHelp(scoped, where);
  if (!hasRegions(scoped)) return null;
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

/** The postal-code form, closed until asked for. Nothing to ask when there is one store. */
export function NearMeDetails({ scoped }: { scoped: ScopedStores }) {
  if (scoped.stores.length < 2) return null;
  const { near } = scoped;
  return (
    <NearMeForm
      fsa={near?.fsa ?? null}
      radiusKm={near?.radiusKm ?? DEFAULT_NEAR_RADIUS}
      summary={near ? `Stores near ${near.fsa}: change` : "Stores near me"}
    />
  );
}

/** The control with its line beside it, for the basket, product page and home page. */
export function StoreScopeRow({ scoped, where }: { scoped: ScopedStores; where: "results" | "home" }) {
  const help = storeScopeHelp(scoped, where);
  if (help === null && where !== "home") return null;
  return (
    <div className="scope-row">
      <StoreScopeControl scoped={scoped} />
      {help && <p className="scope-help">{help}</p>}
      {where === "home" && <NearMeDetails scoped={scoped} />}
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
