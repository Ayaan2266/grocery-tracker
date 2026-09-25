import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowDown, ArrowLeft, ArrowUp } from "lucide-react";

import { BasketButton } from "@/components/basket-button";
import { PriceChart, type ChartSeries } from "@/components/price-chart";
import { StoreChip, estimatedRegular } from "@/components/price-row";
import { SearchForm } from "@/components/search-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { readBasket } from "@/lib/basket";
import { rangePercent, summarize, type Verdict } from "@/lib/history";
import { sameItemListings, similarListings, type SameItem } from "@/lib/matching";
import {
  getPriceHistory,
  getProduct,
  getSameItemCandidates,
  getSimilarCandidates,
  type LatestPrice,
} from "@/lib/queries";
import { BANNER_COLORS, BANNER_SHORT, bannerLabel, storeArea, storeName } from "@/lib/stores";
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

/** "$0.20 below typical", or above it, when the verdict gives today's price a side. */
function TypicalPill({ price, verdict }: { price: number; verdict: Verdict | null }) {
  if (!verdict || verdict.kind === "new" || verdict.kind === "steady") return null;
  const gap = price - verdict.typical;
  if (gap === 0) return null;
  const Icon = gap < 0 ? ArrowDown : ArrowUp;
  return (
    <span className={`typical-pill ${gap < 0 ? "typical-pill-good" : "typical-pill-bad"}`}>
      <Icon size={14} strokeWidth={2.6} aria-hidden="true" />
      {formatCents(Math.abs(gap))} {gap < 0 ? "below" : "above"} typical
    </span>
  );
}

function PriceCard({
  product,
  quantity,
  verdict,
  storeCount,
}: {
  product: LatestPrice;
  quantity: number;
  verdict: Verdict | null;
  storeCount: number;
}) {
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
      <div className="price-card-headline">
        <p className="price-card-amount">{formatCents(product.price_cents)}</p>
        <TypicalPill price={product.price_cents} verdict={verdict} />
      </div>
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
      <div className="price-card-actions">
        <BasketButton productId={product.product_id} quantity={quantity} />
        {storeCount > 1 && (
          <a href="#compare" className="outline-button">
            Compare {storeCount} stores <ArrowDown size={16} aria-hidden="true" />
          </a>
        )}
      </div>
      {estimated !== null && (
        <p className="price-note">
          * Estimated from the store’s own unit price. The store does not label this as a sale.
        </p>
      )}
    </section>
  );
}

/**
 * Lowest to highest recorded price, with the stretch below typical in green,
 * typical marked in yellow, and a marker where today's price sits.
 */
function RangeBar({ verdict, price }: { verdict: Verdict; price: number }) {
  const { lowest, typical, highest } = verdict;
  const typicalAt = rangePercent(typical, lowest, highest);
  const todayAt = rangePercent(price, lowest, highest);
  const tone =
    verdict.kind === "lowest" || verdict.kind === "below" ? "good" : verdict.kind === "above" ? "bad" : "neutral";
  return (
    <div
      className="range-bar"
      role="img"
      aria-label={`${formatCents(price)} today, against a low of ${formatCents(lowest)}, a typical ${formatCents(typical)} and a high of ${formatCents(highest)}`}
    >
      <span className="range-today" style={{ left: `${todayAt}%`, transform: `translateX(-${todayAt}%)` }}>
        Latest {formatCents(price)}
      </span>
      <div className="range-track">
        <span className="range-good" style={{ width: `${typicalAt}%` }} />
        <span className="range-typical" style={{ left: `clamp(0%, calc(${typicalAt}% - 6%), 88%)` }} />
        <span className={`range-marker range-marker-${tone}`} style={{ left: `${todayAt}%` }} />
      </div>
      <div className="range-labels" aria-hidden="true">
        <span>Low {formatCents(lowest)}</span>
        <span>Typical {formatCents(typical)}</span>
        <span>High {formatCents(highest)}</span>
      </div>
    </div>
  );
}

function VerdictCard({ verdict, price }: { verdict: Verdict | null; price: number }) {
  if (!verdict) {
    return (
      <section className="verdict-card">
        <p className="section-label">Is it a good price?</p>
        <h2>No history yet</h2>
      </section>
    );
  }
  const { headline, detail } = verdictText(verdict);
  const hasRange = verdict.lowest < verdict.highest;
  return (
    <section className={`verdict-card verdict-${verdict.kind}`} aria-label="Is it a good price?">
      <p className="section-label">Is it a good price?</p>
      <h2>{headline}</h2>
      <p>{detail}</p>
      {hasRange && <RangeBar verdict={verdict} price={price} />}
      {verdict.kind !== "new" && (
        <p className="price-note">
          Based on {verdict.daysTracked} day{verdict.daysTracked === 1 ? "" : "s"} of prices
          {verdict.daysTracked < 30 ? ". It gets sharper every night." : ` since ${formatDay(verdict.since)}.`}
        </p>
      )}
    </section>
  );
}

function StoreComparison({
  items,
  currentId,
  query,
}: {
  items: SameItem<LatestPrice>[];
  currentId: number;
  query: string;
}) {
  const listings = items.map((item) => item.listing);
  const otherCode = new Set(items.filter((item) => !item.byCode).map((item) => item.listing.product_id));
  const sorted = [...listings].sort(
    (a, b) => Number(b.in_stock) - Number(a.in_stock) || a.price_cents - b.price_cents,
  );
  // Out-of-stock listings are shown but never called cheapest.
  const buyable = sorted.filter((l) => l.in_stock);
  const cheapest = buyable[0] ?? null;
  const priciest = buyable[buyable.length - 1] ?? null;
  const current = listings.find((l) => l.product_id === currentId) ?? null;
  const top = Math.max(...listings.map((l) => l.price_cents));
  const name = (l: LatestPrice) => BANNER_SHORT[l.banner_slug] ?? l.retailer_name;

  let pill: string | null = null;
  if (cheapest && priciest && priciest.price_cents > cheapest.price_cents) {
    pill =
      current && current.in_stock && current.price_cents > cheapest.price_cents
        ? `${formatCents(current.price_cents - cheapest.price_cents)} less at ${name(cheapest)}`
        : `Save ${formatCents(priciest.price_cents - cheapest.price_cents)} vs ${name(priciest)}`;
  }

  return (
    <section className="store-compare" id="compare" aria-labelledby="compare-title">
      <div className="store-compare-header">
        <div>
          <h2 id="compare-title">Same item at other stores</h2>
          <p>
            Matched by the product code the stores share, or by the same brand, name and package
            under another code. Latest recorded price at each.
          </p>
        </div>
        {pill && <span className="save-pill">{pill}</span>}
      </div>
      <ul>
        {sorted.map((listing) => {
          const unit = formatUnitPrice(
            listing.unit_price_cents,
            listing.comparison_quantity,
            listing.comparison_unit,
          );
          const isCurrent = listing.product_id === currentId;
          const area = storeArea(listing.store_label);
          const isCheapest =
            cheapest !== null && buyable.length > 1 && listing.in_stock && listing.price_cents === cheapest.price_cents;
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
                {area && <span className="store-area">{area}</span>}
                {isCheapest && <small className="cheapest-badge">Cheapest</small>}
                {isCurrent && <small>This listing</small>}
                {otherCode.has(listing.product_id) && <small>Another product code</small>}
                {!listing.in_stock && <small className="stock-badge">Out of stock</small>}
              </span>
              <span className="store-compare-bar" aria-hidden="true">
                <span
                  className={isCheapest ? "is-cheapest" : undefined}
                  style={{ width: `${(listing.price_cents / top) * 100}%` }}
                />
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

/**
 * Other brands and codes with the same description, size and pack. Never
 * called the same item: the heading says so, and the unit price leads.
 */
function SimilarItems({ items, query }: { items: LatestPrice[]; query: string }) {
  return (
    <section className="store-compare similar-items" aria-labelledby="similar-title">
      <div className="store-compare-header">
        <div>
          <h2 id="similar-title">Similar items</h2>
          <p>
            Other brands with the same description and size. Not the same product, so compare the unit
            price. Cheapest per unit first.
          </p>
        </div>
      </div>
      <ul>
        {items.map((item) => {
          const unit = formatUnitPrice(item.unit_price_cents, item.comparison_quantity, item.comparison_unit);
          return (
            <li key={item.product_id}>
              <span className="store-dot" style={{ background: BANNER_COLORS[item.banner_slug] ?? "#53617e" }} aria-hidden="true" />
              <span className="store-compare-name">
                <Link href={`/product/${item.product_id}?${new URLSearchParams({ q: query })}`}>
                  {[item.brand, item.raw_name].filter(Boolean).join(" ")}
                </Link>
                <small>{storeName(item.banner_slug, item.retailer_name, item.store_label)}</small>
              </span>
              <span className="similar-size">{item.package_size}</span>
              <span className="store-compare-price">
                <strong>{unit ?? formatCents(item.price_cents)}</strong>
                {unit && <small>{formatCents(item.price_cents)}</small>}
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

  const candidates = product ? await getSameItemCandidates([product]) : null;
  const sameItems = product ? sameItemListings(product, candidates?.data ?? []) : [];
  const allListings = sameItems.map((item) => item.listing);
  const [history, similarCandidates] = await Promise.all([
    getPriceHistory(allListings.map((l) => l.product_id)),
    getSimilarCandidates(product?.substitute_key ? [product.substitute_key] : []),
  ]);
  const similar = product
    ? similarListings(product, similarCandidates.data ?? [], new Set(allListings.map((l) => l.product_id)))
    : [];

  const spansFor = (productId: number) =>
    (history.data ?? []).filter((span) => span.product_id === productId);
  const series: ChartSeries[] = [...allListings]
    .sort((a, b) => (a.product_id === id ? -1 : b.product_id === id ? 1 : 0))
    .map((listing) => ({
      key: `p${listing.product_id}`,
      label: BANNER_SHORT[listing.banner_slug] ?? listing.retailer_name,
      color: BANNER_COLORS[listing.banner_slug] ?? "#53617e",
      current: listing.price_cents,
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
                <StoreChip row={product} />
                <h1>{product.raw_name}</h1>
                <p>{[product.brand, product.package_size].filter(Boolean).join(" · ") || "Grocery item"}</p>
              </header>

              <div className="product-grid">
                <PriceCard
                  product={product}
                  quantity={basket.get(product.product_id) ?? 0}
                  verdict={verdict}
                  storeCount={allListings.length}
                />
                <VerdictCard verdict={verdict} price={product.price_cents} />
              </div>

              <section className="chart-card" aria-labelledby="history-title">
                {history.error ? (
                  <>
                    <h2 id="history-title">Price history</h2>
                    <div role="alert" className="data-alert">Price history is unavailable right now.</div>
                  </>
                ) : (
                  <PriceChart
                    series={series}
                    titleId="history-title"
                    subtitle={
                      series.length > 1
                        ? "This item at every store that carries it. Hover or tap for each day."
                        : "Hover or tap for the price on each day."
                    }
                  />
                )}
              </section>

              {allListings.length > 1 && (
                <StoreComparison items={sameItems} currentId={product.product_id} query={query} />
              )}

              {similar.length > 0 && <SimilarItems items={similar} query={query} />}
            </>
          )}
        </article>

        <SiteFooter />
      </div>
    </main>
  );
}
