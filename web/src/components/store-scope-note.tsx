import { setStoreScope } from "@/app/stores/actions";
import type { StoreInfo } from "@/lib/queries";
import { storeName, type StoreScope } from "@/lib/stores";

const list = new Intl.ListFormat("en-CA", { type: "conjunction" });

/**
 * Says which stores the prices on a page come from, and switches between the
 * Ontario stores (the default) and every store. A form posting to a server
 * action, like the basket buttons, so it works with JavaScript off. Renders
 * nothing when every store is already in Ontario.
 */
export function StoreScopeNote({ scope, hidden }: { scope: StoreScope; hidden: StoreInfo[] }) {
  if (scope === "ontario" && hidden.length === 0) return null;
  const names = list.format(hidden.map((s) => storeName(s.banner_slug, s.retailer_name, s.label)));
  return (
    <form action={setStoreScope} className="scope-note">
      <input type="hidden" name="scope" value={scope === "all" ? "ontario" : "all"} />
      <span>
        {scope === "all"
          ? "Showing every store, including those outside Ontario."
          : `Showing Ontario stores. Also checked nightly: ${names}.`}
      </span>
      <button type="submit">{scope === "all" ? "Ontario stores only" : "Show all stores"}</button>
    </form>
  );
}
