import { NearMeForm } from "@/components/near-me-form";
import { setStoreScope } from "@/app/stores/actions";
import { DEFAULT_NEAR_RADIUS } from "@/lib/postal";
import type { ScopedStores } from "@/lib/store-scope";
import { BANNER_COLORS, markDot, storeName, type StoreScope } from "@/lib/stores";

const list = new Intl.ListFormat("en-CA", { type: "conjunction" });

/**
 * The stores near the saved postal code, or every store, as a segmented
 * control matching the sort toggle. One form with a submit button per choice
 * posting to a server action, like the basket buttons, so it works with
 * JavaScript off. Renders nothing until a place is saved: there is no choice
 * to make before that.
 */
export function StoreScopeControl({ scoped }: { scoped: ScopedStores }) {
  const { scope, stores, near, nearStores } = scoped;
  if (!near || !nearStores) return null;
  const options: { value: StoreScope; label: string; count: number }[] = [
    { value: "near", label: `Near ${near.fsa}`, count: nearStores.ids.length },
    { value: "all", label: "All stores", count: stores.length },
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
 * What the stores near the visitor leave out, in one line, or null when every
 * store is shown. "results" sits under prices; "home" explains where the
 * choice applies.
 */
export function storeScopeHelp(scoped: ScopedStores, where: "results" | "home"): string | null {
  return scoped.scope === "near" ? nearHelp(scoped, where) : null;
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
 * A banner's colour as a dot: filled for its first store, then a ring, a ring
 * round a centre and a half-filled dot for the others (STORE_MARKS), so two
 * Superstores never look like one.
 */
export function StoreDot({
  slug,
  mark = 0,
  as: Tag = "span",
  className = "store-dot",
}: {
  slug: string;
  /** Index into STORE_MARKS, from ScopedStores.marks. */
  mark?: number;
  as?: "span" | "i";
  className?: string;
}) {
  const dot = markDot(BANNER_COLORS[slug] ?? "#53617e", mark);
  return (
    <Tag
      className={[className, dot.className].filter(Boolean).join(" ") || undefined}
      style={dot.style}
      aria-hidden="true"
    />
  );
}
