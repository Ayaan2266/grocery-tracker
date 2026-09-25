import type { Metadata } from "next";
import Link from "next/link";
import { Minus, Plus, X } from "lucide-react";

import { changeQuantity, clearBasket, removeFromBasket } from "@/app/basket/actions";
import { SearchForm } from "@/components/search-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { readBasket } from "@/lib/basket";
import { sameItemListings, similarListings } from "@/lib/matching";
import {
  getProducts,
  getSameItemCandidates,
  getSimilarCandidates,
  type LatestPrice,
} from "@/lib/queries";
import { BANNER_COLORS, BANNER_SHORT, storeArea, storeName } from "@/lib/stores";
import { formatCents, formatUnitPrice } from "@/lib/utils";

export const metadata: Metadata = { title: "Basket | Loonie" };

type Store = { id: number; slug: string; name: string; area: string | null };

type Line = {
  product: LatestPrice;
  quantity: number;
  /** This item's listing at each store, by store id. In stock only: these are what get totalled. */
  byStore: Map<number, LatestPrice>;
  /** Listed but out of stock, so shown and left out of the totals. */
  outOfStock: Map<number, LatestPrice>;
  cheapest: LatestPrice | null;
  /** A different product, at any store, cheaper per unit than this one anywhere. Never totalled. */
  cheaperSimilar: LatestPrice | null;
};

function QuantityControls({ productId, quantity }: { productId: number; quantity: number }) {
  return (
    <div className="qty-controls">
      <form action={changeQuantity}>
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="delta" value={-1} />
        <button type="submit" aria-label="One fewer"><Minus size={15} aria-hidden="true" /></button>
      </form>
      <span aria-label={`Quantity ${quantity}`}>{quantity}</span>
      <form action={changeQuantity}>
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="delta" value={1} />
        <button type="submit" aria-label="One more"><Plus size={15} aria-hidden="true" /></button>
      </form>
      <form action={removeFromBasket}>
        <input type="hidden" name="productId" value={productId} />
        <button type="submit" className="qty-remove" aria-label="Remove from basket"><X size={15} aria-hidden="true" /></button>
      </form>
    </div>
  );
}

type StoreTotal = { store: Store; total: number; carried: number; missing: number; outOfStock: number };

function coverageNote({ missing, outOfStock }: StoreTotal): string {
  const parts: string[] = [];
  if (missing > 0) parts.push(`Missing ${missing} item${missing === 1 ? "" : "s"}`);
  if (outOfStock > 0) parts.push(`${outOfStock} out of stock`);
  return parts.length > 0 ? parts.join(" · ") : "Has everything";
}

/** "Old Cheddar at Loblaws, the rest at Superstore": where the cheapest mix buys each product. */
function mixDescription(lines: Line[], storeName: (id: number) => string): string {
  const byStore = new Map<number, string[]>();
  for (const line of lines) {
    if (!line.cheapest) continue;
    const names = byStore.get(line.cheapest.store_id) ?? [];
    names.push(line.product.raw_name);
    byStore.set(line.cheapest.store_id, names);
  }
  const groups = [...byStore.entries()].sort((a, b) => b[1].length - a[1].length);
  if (groups.length === 0) return "";
  if (groups.length === 1) return `Everything at ${storeName(groups[0][0])}`;
  const [main, ...others] = groups;
  const parts = others.map(([id, names]) => `${names.join(", ")} at ${storeName(id)}`);
  parts.push(main[1].length > 1 ? `the rest at ${storeName(main[0])}` : `${main[1][0]} at ${storeName(main[0])}`);
  return parts.join(", ");
}

function BasketSummary({
  lines,
  totals,
  bestComplete,
  mixTotal,
  comparable,
  storeName,
}: {
  lines: Line[];
  totals: StoreTotal[];
  bestComplete: StoreTotal | null;
  mixTotal: number;
  comparable: boolean;
  storeName: (id: number) => string;
}) {
  if (!comparable) {
    const total = lines.reduce((sum, line) => sum + line.product.price_cents * line.quantity, 0);
    return (
      <aside className="basket-summary" aria-label="Basket total">
        <h2>Basket total</h2>
        <p className="basket-summary-total">{formatCents(total)}</p>
        <p className="price-note">
          None of these products is listed at more than one store yet, so there is nothing to
          compare. Store totals appear as soon as two stores carry the same item.
        </p>
      </aside>
    );
  }
  const top = Math.max(...totals.map((t) => t.total), 1);
  const saving = bestComplete ? bestComplete.total - mixTotal : 0;
  const mixNote = mixDescription(lines, storeName);
  return (
    <aside className="basket-summary" aria-label="Store totals">
      <h2>Store totals</h2>
      <ul className="store-totals">
        {totals.map((t) => {
          const isBest = bestComplete?.store.id === t.store.id;
          return (
            <li key={t.store.id} className={isBest ? "is-best" : undefined}>
              <span className="store-dot" style={{ background: BANNER_COLORS[t.store.slug] ?? "#53617e" }} aria-hidden="true" />
              <strong>{t.store.name}</strong>
              <small>{coverageNote(t)}</small>
              <span className="store-totals-amount">{formatCents(t.total)}</span>
              {t.store.area && <span className="store-totals-area">{t.store.area}</span>}
              <span className="store-totals-bar" aria-hidden="true">
                <span style={{ width: `${(t.total / top) * 100}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      {bestComplete ? (
        <div className="summary-card summary-best">
          <p className="section-label">Best single shop</p>
          <p className="summary-card-amount">
            {bestComplete.store.name} · {formatCents(bestComplete.total)}
          </p>
          <p>
            Everything on your list in one trip
            {bestComplete.store.area ? ` to ${bestComplete.store.name} ${bestComplete.store.area}` : ""}.
          </p>
        </div>
      ) : (
        <div className="summary-card">
          <p className="section-label">Best single shop</p>
          <p>No one store has everything in stock. The cheapest mix below covers what it can.</p>
        </div>
      )}
      <div className="summary-card summary-mix">
        <p className="section-label">Cheapest mix</p>
        <p className="summary-card-amount">
          {formatCents(mixTotal)}
          {saving > 0 && <> · saves {formatCents(saving)}</>}
        </p>
        {mixNote && <p>{mixNote}.</p>}
      </div>
    </aside>
  );
}

function StoreCell({ line, store }: { line: Line; store: Store }) {
  const listing = line.byStore.get(store.id);
  const unavailable = line.outOfStock.get(store.id);
  const isCheapest = listing && line.byStore.size > 1 && listing.price_cents === line.cheapest?.price_cents;
  return (
    <li className={isCheapest ? "store-cell is-cheapest" : "store-cell"} title={store.area ?? undefined}>
      <span className="store-cell-name">
        <span className="store-dot" style={{ background: BANNER_COLORS[store.slug] ?? "#53617e" }} aria-hidden="true" />
        {store.name}
      </span>
      {listing ? (
        <span className="store-cell-price">
          <strong>{formatCents(listing.price_cents * line.quantity)}</strong>
          {line.quantity > 1 && <small>{formatCents(listing.price_cents)} each</small>}
        </span>
      ) : (
        <small className={unavailable ? "stock-label" : undefined}>{unavailable ? "Out of stock" : "Not listed"}</small>
      )}
    </li>
  );
}

/**
 * "Similar for less": the cheapest different product with the same
 * description and size, when it beats this one's best unit price. A
 * suggestion only; the totals above never include it.
 */
function CheaperSimilar({ line }: { line: Line }) {
  const similar = line.cheaperSimilar;
  if (!similar) return null;
  const unit = formatUnitPrice(similar.unit_price_cents, similar.comparison_quantity, similar.comparison_unit);
  const ours = line.cheapest
    ? formatUnitPrice(line.cheapest.unit_price_cents, line.cheapest.comparison_quantity, line.cheapest.comparison_unit)
    : null;
  return (
    <p className="similar-hint">
      <span className="similar-hint-label">Similar for less</span>
      <Link href={`/product/${similar.product_id}`}>
        {[similar.brand, similar.raw_name].filter(Boolean).join(" ")}
      </Link>{" "}
      at {storeName(similar.banner_slug, similar.retailer_name, similar.store_label)} · {formatCents(similar.price_cents)}
      {unit && ours && <> · {unit} against {ours}</>}
    </p>
  );
}

function EmptyBasket() {
  return (
    <div className="empty-state basket-empty">
      <p>Your basket is empty.</p>
      <p>
        Search for groceries and tap <strong>Add to basket</strong>. Loonie then shows what the whole
        list costs at each store. Try <Link href="/?q=milk#prices">milk</Link> or{" "}
        <Link href="/?q=bread#prices">bread</Link>.
      </p>
    </div>
  );
}

export default async function BasketPage() {
  const basket = await readBasket();
  const ids = [...basket.keys()];
  const products = await getProducts(ids);
  const items = (products.data ?? []).filter((p) => basket.has(p.product_id));
  const [listings, similarCandidates] = await Promise.all([
    getSameItemCandidates(items),
    getSimilarCandidates([
      ...new Set(items.map((p) => p.substitute_key).filter((k): k is string => !!k)),
    ]),
  ]);
  const error = products.error ?? listings.error;

  // Every store any item is listed at, in a stable order.
  const stores = new Map<number, Store>();
  for (const listing of [...items, ...(listings.data ?? [])]) {
    stores.set(listing.store_id, {
      id: listing.store_id,
      slug: listing.banner_slug,
      name: BANNER_SHORT[listing.banner_slug] ?? listing.retailer_name,
      area: storeArea(listing.store_label),
    });
  }
  const storeList = [...stores.values()].sort((a, b) => a.id - b.id);

  // Keep the order items were added in.
  const lines: Line[] = ids
    .map((id) => items.find((p) => p.product_id === id))
    .filter((p): p is LatestPrice => p !== undefined)
    .map((product) => {
      const byStore = new Map<number, LatestPrice>();
      const outOfStock = new Map<number, LatestPrice>();
      // The same item only: its code, or its unambiguous identity key. A similar
      // product is never priced into a store's total as if it were this one.
      const same = sameItemListings(product, listings.data ?? []);
      for (const { listing } of same) {
        (listing.in_stock ? byStore : outOfStock).set(listing.store_id, listing);
      }
      const cheapest = [...byStore.values()].sort((a, b) => a.price_cents - b.price_cents)[0] ?? null;
      const [similar] = similarListings(
        product,
        similarCandidates.data ?? [],
        new Set(same.map((s) => s.listing.product_id)),
        1,
      );
      const cheaperSimilar =
        similar &&
        cheapest &&
        similar.unit_price_cents !== null &&
        cheapest.unit_price_cents !== null &&
        similar.comparison_unit === cheapest.comparison_unit &&
        similar.unit_price_cents < cheapest.unit_price_cents
          ? similar
          : null;
      return {
        product,
        quantity: basket.get(product.product_id) ?? 1,
        byStore,
        outOfStock,
        cheapest,
        cheaperSimilar,
      };
    });

  const totals: StoreTotal[] = storeList.map((store) => {
    let total = 0;
    let carried = 0;
    let outOfStock = 0;
    for (const line of lines) {
      const listing = line.byStore.get(store.id);
      if (listing) {
        total += listing.price_cents * line.quantity;
        carried += 1;
      } else if (line.outOfStock.has(store.id)) {
        outOfStock += 1;
      }
    }
    return { store, total, carried, outOfStock, missing: lines.length - carried - outOfStock };
  });
  const complete = totals.filter((t) => t.carried === lines.length && lines.length > 0);
  const bestComplete = complete.sort((a, b) => a.total - b.total)[0] ?? null;
  const mixLines = lines.filter((line) => line.cheapest !== null);
  const mixTotal = mixLines.reduce((sum, line) => sum + line.cheapest!.price_cents * line.quantity, 0);
  const comparable = lines.some((line) => line.byStore.size + line.outOfStock.size > 1);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  // Where each part of the cheapest mix is bought, place included: a mix can
  // span stores a long way apart.
  const storeName = (id: number) => {
    const store = stores.get(id);
    if (!store) return "another store";
    return store.area ? `${store.name} ${store.area}` : store.name;
  };

  return (
    <main>
      <div className="site-shell" id="top">
        <div className="hero-wrap hero-wrap-compact">
          <SiteHeader />
          <div className="compact-search">
            <SearchForm compact />
          </div>
        </div>

        <article className="basket-page">
          <div className="section-heading">
            <div>
              <p className="section-label">Your basket</p>
              <h1>Where is your list cheapest?</h1>
              <p>
                {lines.length > 0
                  ? `${lines.length} product${lines.length === 1 ? "" : "s"} · ${itemCount} item${itemCount === 1 ? "" : "s"} · latest recorded prices`
                  : "Add groceries from any search and compare the total at each store."}
              </p>
            </div>
            {lines.length > 0 && (
              <form action={clearBasket}>
                <button type="submit" className="clear-search clear-basket">Empty basket</button>
              </form>
            )}
          </div>

          {error && (
            <div role="alert" className="data-alert">Price data is unavailable right now. Please try again soon.</div>
          )}

          {lines.length === 0 ? (
            <EmptyBasket />
          ) : (
            <div className="basket-layout">
              <BasketSummary
                lines={lines}
                totals={totals}
                bestComplete={bestComplete}
                mixTotal={mixTotal}
                comparable={comparable}
                storeName={storeName}
              />
              <div className="basket-items">
                <ul className="basket-list">
                  {lines.map((line) => (
                    <li key={line.product.product_id} className="basket-item">
                      <div className="basket-item-head">
                        <div>
                          <h2>
                            <Link href={`/product/${line.product.product_id}`}>{line.product.raw_name}</Link>
                          </h2>
                          <p>{[line.product.brand, line.product.package_size].filter(Boolean).join(" · ") || "Grocery item"}</p>
                        </div>
                        <QuantityControls productId={line.product.product_id} quantity={line.quantity} />
                      </div>
                      <ul className="store-cells" aria-label={`${line.product.raw_name} at each store`}>
                        {storeList.map((store) => (
                          <StoreCell key={store.id} line={line} store={store} />
                        ))}
                      </ul>
                      <CheaperSimilar line={line} />
                    </li>
                  ))}
                </ul>
                <p className="price-note">
                  Totals count the same item only: the product code the stores share, or the same brand,
                  name and package under another code. Similar items are suggestions and never counted.
                  Out-of-stock listings are left out. Prices are recorded snapshots, not checkout quotes.
                </p>
              </div>
            </div>
          )}
        </article>

        <SiteFooter />
      </div>
    </main>
  );
}
