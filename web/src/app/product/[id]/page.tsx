import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { BasketButton } from "@/components/basket-button";
import { PriceChart, type ChartSeries } from "@/components/price-chart";
import { estimatedRegular } from "@/components/price-row";
import { SearchForm } from "@/components/search-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { readBasket } from "@/lib/basket";
import { summarize, type Verdict } from "@/lib/history";
import { getListingsBySku, getPriceHistory, getProduct, type LatestPrice } from "@/lib/queries";
import { BANNER_COLORS, BANNER_SHORT, bannerLabel } from "@/lib/stores";
import { formatCents, formatDay, formatUnitPrice } from "@/lib/utils";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
};

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const id = parseId((await params).id);
  const product = id === null ? null : (await getProduct(id)).data;
  return {
    title: product ? `${product.raw_name} price history | Loonie` : "Product | Loonie",
  };
}

function verdictText(verdict: Verdict): { headline: string; detail: string } {
  const since = formatDay(verdict.since);
  switch (verdict.kind) {
    case "new":
      return {
        headline: "Just started tracking",
        detail: `First recorded ${since}. The graph fills in as prices are checked each night.`,
      };
    case "steady":
      return {
        headline: "Same price every day",
        detail: `It has been ${formatCents(verdict.lowest)} every day since ${since}.`,
      };
    case "lowest":
      return {
        headline: "Lowest price recorded",
        detail: `Nothing cheaper since ${since}. Its typical price is ${formatCents(verdict.typical)}.`,
      };
    case "below":
      return {
        headline: "Below its typical price",
        detail: `It usually sells for ${formatCents(verdict.typical)} here.`,
      };
    case "above":
      return {
        headline: "Above its typical price",
        detail: `It usually sells for ${formatCents(verdict.typical)} here. It has been as low as ${formatCents(verdict.lowest)}.`,
      };
    default:
      return {
        headline: "Its typical price",
        detail: `It has ranged from ${formatCents(verdict.lowest)} to ${formatCents(verdict.highest)} since ${since}.`,
      };
  }
}

function PriceCard({ product, quantity }: { product: LatestPrice; quantity: number }) {
  const estimated = estimatedRegular(product);
  const regular = product.was_price_cents ?? estimated;
  const saving = regular !== null ? regular - product.price_cents : 0;
  const unitPrice = formatUnitPrice(
    product.unit_price_cents,
    product.comparison_quantity,
    product.comparison_unit,
  );

  return (
    <section className="price-card" aria-label="Current price">
      <p className="section-label">Latest price</p>
      <p className="price-card-amount">{formatCents(product.price_cents)}</p>
      {product.was_price_cents !== null && (
        <p className="sale-label">
          Store sale · was {formatCents(product.was_price_cents)}
          {saving > 0 && <> · save {formatCents(saving)}</>}
        </p>
      )}
      {estimated !== null && (
        <p className="estimate-label">
          Usually ~{formatCents(estimated)}* · about {formatCents(saving)} off
        </p>
      )}
      <ul className="price-card-facts">
        {unitPrice && <li>{unitPrice}</li>}
        <li>{product.in_stock ? "In stock" : <span className="stock-label">Out of stock</span>}</li>
        <li>Recorded {formatDay(product.observed_on)}</li>
      </ul>
      <BasketButton productId={product.product_id} quantity={quantity} />
      {estimated !== null && (
        <p className="price-note">
          * Estimated from the store’s own unit price. The store does not label this as a sale.
        </p>
      )}
    </section>
  );
}

function VerdictCard({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) {
    return (
      <section className="verdict-card">
        <p className="section-label">Is it a good price?</p>
        <h2>No history yet</h2>
      </section>
    );
  }
  const { headline, detail } = verdictText(verdict);
  return (
    <section className={`verdict-card verdict-${verdict.kind}`} aria-label="Is it a good price?">
      <p className="section-label">Is it a good price?</p>
      <h2>{headline}</h2>
      <p>{detail}</p>
      <dl className="verdict-stats">
        <div><dt>Lowest</dt><dd>{formatCents(verdict.lowest)}</dd></div>
        <div><dt>Typical</dt><dd>{formatCents(verdict.typical)}</dd></div>
        <div><dt>Highest</dt><dd>{formatCents(verdict.highest)}</dd></div>
        <div><dt>Tracked</dt><dd>{verdict.daysTracked} day{verdict.daysTracked === 1 ? "" : "s"}</dd></div>
      </dl>
      {verdict.daysTracked < 14 && verdict.kind !== "new" && (
        <p className="price-note">
          Only {verdict.daysTracked} days of history so far, so this gets more reliable every night.
        </p>
      )}
    </section>
  );
}

function StoreComparison({
  listings,
  currentId,
  query,
}: {
  listings: LatestPrice[];
  currentId: number;
  query: string;
}) {
  const sorted = [...listings].sort((a, b) => a.price_cents - b.price_cents);
  const cheapest = sorted[0].price_cents;
  return (
    <section className="store-compare" aria-labelledby="compare-title">
      <h2 id="compare-title">Same item at other stores</h2>
      <p>Matched by the product code the stores share. Latest recorded price at each.</p>
      <ul>
        {sorted.map((listing) => {
          const unit = formatUnitPrice(
            listing.unit_price_cents,
            listing.comparison_quantity,
            listing.comparison_unit,
          );
          const isCurrent = listing.product_id === currentId;
          return (
            <li key={listing.product_id} className={isCurrent ? "is-current" : undefined}>
              <span className="store-dot" style={{ background: BANNER_COLORS[listing.banner_slug] ?? "#53617e" }} aria-hidden="true" />
              <span className="store-compare-name">
                {isCurrent ? (
                  bannerLabel(listing.banner_slug, listing.retailer_name)
                ) : (
                  <Link href={`/product/${listing.product_id}?${new URLSearchParams({ q: query })}`}>
                    {bannerLabel(listing.banner_slug, listing.retailer_name)}
                  </Link>
                )}
                {isCurrent && <small>This listing</small>}
                {listing.price_cents === cheapest && sorted.length > 1 && <small className="cheapest-badge">Cheapest</small>}
              </span>
              <span className="store-compare-price">
                <strong>{formatCents(listing.price_cents)}</strong>
                {unit && <small>{unit}</small>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default async function ProductPage({ params, searchParams }: Props) {
  const id = parseId((await params).id);
  if (id === null) notFound();
  const rawQuery = (await searchParams).q;
  const query = (Array.isArray(rawQuery) ? rawQuery[0] : rawQuery)?.trim() ?? "";

  const [productResult, basket] = await Promise.all([getProduct(id), readBasket()]);
  if (productResult.data === null && productResult.error === null) notFound();
  const product = productResult.data;

  const listings = product ? await getListingsBySku([product.retailer_sku]) : null;
  const allListings = listings?.data ?? (product ? [product] : []);
  const history = await getPriceHistory(allListings.map((l) => l.product_id));

  const spansFor = (productId: number) =>
    (history.data ?? []).filter((span) => span.product_id === productId);
  const series: ChartSeries[] = [...allListings]
    .sort((a, b) => (a.product_id === id ? -1 : b.product_id === id ? 1 : 0))
    .map((listing) => ({
      key: `p${listing.product_id}`,
      label: BANNER_SHORT[listing.banner_slug] ?? listing.retailer_name,
      color: BANNER_COLORS[listing.banner_slug] ?? "#53617e",
      spans: spansFor(listing.product_id),
      primary: listing.product_id === id,
    }))
    .filter((s) => s.spans.length > 0);
  const verdict = product ? summarize(spansFor(id), product.price_cents) : null;
  const backHref = query ? `/?${new URLSearchParams({ q: query })}#prices` : "/";

  return (
    <main>
      <div className="site-shell" id="top">
        <div className="hero-wrap hero-wrap-compact">
          <SiteHeader />
          <div className="compact-search">
            <SearchForm query={query} compact />
          </div>
        </div>

        <article className="product-page">
          <Link href={backHref} className="back-link">
            <ArrowLeft size={18} aria-hidden="true" />
            {query ? `Back to results for “${query}”` : "Back to search"}
          </Link>

          {!product ? (
            <div role="alert" className="data-alert">
              Price data is unavailable right now. Please try again soon.
            </div>
          ) : (
            <>
              <header className="product-heading">
                <p className="section-label">{bannerLabel(product.banner_slug, product.retailer_name)}</p>
                <h1>{product.raw_name}</h1>
                <p>{[product.brand, product.package_size].filter(Boolean).join(" · ") || "Grocery item"}</p>
              </header>

              <div className="product-grid">
                <PriceCard product={product} quantity={basket.get(product.product_id) ?? 0} />
                <VerdictCard verdict={verdict} />
              </div>

              <section className="chart-card" aria-labelledby="history-title">
                <h2 id="history-title">Price history</h2>
                <p>
                  {series.length > 1
                    ? "This item at every store that carries it. Hover or tap for the price on each day."
                    : "Hover or tap for the price on each day."}
                </p>
                {history.error ? (
                  <div role="alert" className="data-alert">Price history is unavailable right now.</div>
                ) : (
                  <PriceChart series={series} />
                )}
              </section>

              {allListings.length > 1 && (
                <StoreComparison listings={allListings} currentId={product.product_id} query={query} />
              )}
            </>
          )}
        </article>

        <SiteFooter />
      </div>
    </main>
  );
}
