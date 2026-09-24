import type { Metadata } from "next";
import Link from "next/link";
import { Minus, Plus, Trash2 } from "lucide-react";

import { changeQuantity, clearBasket, removeFromBasket } from "@/app/basket/actions";
import { SearchForm } from "@/components/search-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { readBasket } from "@/lib/basket";
import { getListingsBySku, getProducts, type LatestPrice } from "@/lib/queries";
import { BANNER_COLORS, BANNER_SHORT } from "@/lib/stores";
import { formatCents } from "@/lib/utils";

export const metadata: Metadata = { title: "Basket | Loonie" };

type Store = { id: number; slug: string; name: string };

type Line = {
  product: LatestPrice;
  quantity: number;
  /** This item's listing at each store, by store id. In stock only: these are what get totalled. */
  byStore: Map<number, LatestPrice>;
  /** Listed but out of stock, so shown and left out of the totals. */
  outOfStock: Map<number, LatestPrice>;
  cheapest: LatestPrice | null;
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
        <button type="submit" className="qty-remove" aria-label="Remove from basket"><Trash2 size={15} aria-hidden="true" /></button>
      </form>
    </div>
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
  const listings = await getListingsBySku([...new Set(items.map((p) => p.retailer_sku))]);
  const error = products.error ?? listings.error;

  // Every store any item is listed at, in a stable order.
  const stores = new Map<number, Store>();
  for (const listing of [...items, ...(listings.data ?? [])]) {
    stores.set(listing.store_id, {
      id: listing.store_id,
      slug: listing.banner_slug,
      name: BANNER_SHORT[listing.banner_slug] ?? listing.retailer_name,
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
      for (const listing of listings.data ?? [product]) {
        if (listing.retailer_sku !== product.retailer_sku) continue;
        (listing.in_stock ? byStore : outOfStock).set(listing.store_id, listing);
      }
      const cheapest = [...byStore.values()].sort((a, b) => a.price_cents - b.price_cents)[0] ?? null;
      return { product, quantity: basket.get(product.product_id) ?? 1, byStore, outOfStock, cheapest };
    });

  const totals = storeList.map((store) => {
    let total = 0;
    let carried = 0;
    for (const line of lines) {
      const listing = line.byStore.get(store.id);
      if (listing) {
        total += listing.price_cents * line.quantity;
        carried += 1;
      }
    }
    return { store, total, carried };
  });
  const complete = totals.filter((t) => t.carried === lines.length && lines.length > 0);
  const bestComplete = complete.sort((a, b) => a.total - b.total)[0] ?? null;
  const mixLines = lines.filter((line) => line.cheapest !== null);
  const mixTotal = mixLines.reduce((sum, line) => sum + line.cheapest!.price_cents * line.quantity, 0);
  const comparable = lines.some((line) => line.byStore.size + line.outOfStock.size > 1);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

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
                  ? `${lines.length} product${lines.length === 1 ? "" : "s"}, ${itemCount} item${itemCount === 1 ? "" : "s"} in total. Prices are the latest recorded at each store.`
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
            <>
              {comparable && (
                <div className="basket-totals">
                  {totals.map(({ store, total, carried }) => {
                    const isBest = bestComplete?.store.id === store.id;
                    return (
                      <div key={store.id} className={isBest ? "basket-total is-best" : "basket-total"}>
                        <span className="store-dot" style={{ background: BANNER_COLORS[store.slug] ?? "#53617e" }} aria-hidden="true" />
                        <p>{store.name}</p>
                        <strong>{formatCents(total)}</strong>
                        <small>
                          {carried === lines.length
                            ? "Has everything"
                            : `${carried} of ${lines.length} products`}
                        </small>
                        {isBest && <em>Cheapest for the whole list</em>}
                      </div>
                    );
                  })}
                  <div className="basket-total basket-mix">
                    <p>Cheapest mix</p>
                    <strong>{formatCents(mixTotal)}</strong>
                    <small>Each product where it costs least</small>
                    {bestComplete && bestComplete.total > mixTotal && (
                      <em>Saves {formatCents(bestComplete.total - mixTotal)} if you split the shop</em>
                    )}
                  </div>
                </div>
              )}

              <div className="basket-table-wrap">
                <table className="basket-table">
                  <thead>
                    <tr>
                      <th scope="col">Product</th>
                      {comparable
                        ? storeList.map((store) => <th scope="col" key={store.id}>{store.name}</th>)
                        : <th scope="col">Price</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.product.product_id}>
                        <th scope="row">
                          <Link href={`/product/${line.product.product_id}`}>{line.product.raw_name}</Link>
                          <small>{[line.product.brand, line.product.package_size].filter(Boolean).join(" · ")}</small>
                          <QuantityControls productId={line.product.product_id} quantity={line.quantity} />
                        </th>
                        {comparable ? (
                          storeList.map((store) => {
                            const listing = line.byStore.get(store.id);
                            const unavailable = line.outOfStock.get(store.id);
                            const isCheapest =
                              listing && line.byStore.size > 1 && listing.price_cents === line.cheapest?.price_cents;
                            return (
                              <td key={store.id} data-label={store.name} className={isCheapest ? "is-cheapest" : undefined}>
                                {listing ? (
                                  <>
                                    <strong>{formatCents(listing.price_cents * line.quantity)}</strong>
                                    {line.quantity > 1 && <small>{formatCents(listing.price_cents)} each</small>}
                                  </>
                                ) : unavailable ? (
                                  <small className="stock-label">Out of stock</small>
                                ) : (
                                  <small>Not listed</small>
                                )}
                              </td>
                            );
                          })
                        ) : (
                          <td data-label="Price">
                            <strong>{formatCents(line.product.price_cents * line.quantity)}</strong>
                            <small>{BANNER_SHORT[line.product.banner_slug] ?? line.product.retailer_name}</small>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {!comparable && (
                <p className="price-note">
                  None of these products is listed at more than one store yet, so there is nothing to
                  compare. Store totals appear as soon as two stores carry the same item.
                </p>
              )}
              <p className="price-note">
                Out-of-stock listings are left out of the totals. Prices are recorded snapshots, not
                checkout quotes.
              </p>
            </>
          )}
        </article>

        <SiteFooter />
      </div>
    </main>
  );
}
