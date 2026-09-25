import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowRight, ChartNoAxesCombined, ShoppingBasket, Tag } from "lucide-react";

import { PriceRow, estimatedRegular } from "@/components/price-row";
import { SearchForm } from "@/components/search-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { readBasket } from "@/lib/basket";
import { BANNER_COLORS, BANNER_SHORT, storeArea } from "@/lib/stores";
import { badgeFor, dailyPrices, dayNumber, isoDay, windowSpans, type Badge } from "@/lib/history";
import {
  MAX_RESULTS,
  PAGE_SIZE,
  getCoverage,
  getRecentHistory,
  getStores,
  searchProducts,
  type LatestPrice,
  type SortOrder,
} from "@/lib/queries";

/** Days drawn in each row's sparkline, and days its badge looks back over. */
const TREND_DAYS = 7;
const BADGE_DAYS = 30;

type RowHistory = { trend: (number | null)[]; badge: Badge | null };

/**
 * Sparklines and badges for a page of results, from one batch of queries.
 * Each row is measured back from its own latest day, so a store whose run is
 * a day behind is not drawn with a missing last day. The fetch window is set
 * by the freshest row, so one stale listing cannot stretch it for the rest;
 * a stale row just gets a shorter look back.
 */
async function rowHistories(rows: LatestPrice[]): Promise<Map<number, RowHistory>> {
  const out = new Map<number, RowHistory>();
  if (rows.length === 0) return out;
  const latest = Math.max(...rows.map((r) => dayNumber(r.observed_on)));
  const history = await getRecentHistory(
    rows.map((r) => r.product_id),
    isoDay(latest - BADGE_DAYS + 1),
  );
  if (!history.data) return out;
  for (const row of rows) {
    const spans = history.data.filter((s) => s.product_id === row.product_id);
    const recent = windowSpans(spans, row.observed_on, BADGE_DAYS);
    out.set(row.product_id, {
      trend: dailyPrices(recent, row.observed_on, TREND_DAYS),
      badge: badgeFor(recent, row.price_cents),
    });
  }
  return out;
}

const staples = [
  { label: "Milk", term: "milk" },
  { label: "Cheddar", term: "cheddar" },
  { label: "Bananas", term: "banana" },
];

type SearchParams = { q?: string | string[]; sort?: string | string[]; n?: string | string[] };

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function searchHref(query: string, sort: SortOrder, count = PAGE_SIZE): string {
  const params = new URLSearchParams({ q: query });
  if (sort !== "price") params.set("sort", sort);
  if (count > PAGE_SIZE) params.set("n", String(count));
  return `/?${params}`;
}

function SortToggle({ query, sort }: { query: string; sort: SortOrder }) {
  const options: { value: SortOrder; label: string }[] = [
    { value: "price", label: "Cheapest price" },
    { value: "value", label: "Best value per 100 g / ml" },
  ];
  return (
    <div className="sort-toggle" role="group" aria-label="Sort results">
      {options.map((option) => (
        <Link
          key={option.value}
          href={`${searchHref(query, option.value)}#prices`}
          aria-current={sort === option.value ? "true" : undefined}
          scroll={false}
        >
          {option.label}
        </Link>
      ))}
    </div>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const query = first(params.q).trim();
  const sort: SortOrder = first(params.sort) === "value" ? "value" : "price";
  const requested = Number.parseInt(first(params.n), 10);
  const count = Number.isFinite(requested)
    ? Math.min(Math.max(requested, PAGE_SIZE), MAX_RESULTS)
    : PAGE_SIZE;

  const [results, coverage, basket, stores] = await Promise.all([
    searchProducts(query, { sort, limit: count }),
    getCoverage(),
    readBasket(),
    getStores(),
  ]);
  const storeList = stores.data ?? [];
  const prices = results.data?.rows ?? [];
  const histories = await rowHistories(prices);
  const hasMore = (results.data?.hasMore ?? false) && count < MAX_RESULTS;
  const error = results.error ?? (!query ? coverage.error : null);
  const productHref = (id: number) => `/product/${id}?${new URLSearchParams({ q: query })}`;

  return (
    <main>
      <a className="skip-link" href="#prices">Skip to prices</a>
      <div className="site-shell" id="top">
        <div className="hero-wrap">
          <SiteHeader />

          <section className="hero" aria-labelledby="hero-title">
            <Image className="hero-tote" src="/illustrations/grocery-tote.png" alt="" width={350} height={350} priority />
            <p className="eyebrow">Same groceries. Smarter choices. <span aria-hidden="true">✦</span></p>
            <h1 id="hero-title">Grocery prices have a story<span className="gold-stop">.</span></h1>
            <p className="hero-description">Find out if today is a good day to buy.</p>
            <SearchForm query={query} />
            <div className="staples" aria-label="Try a staple">
              <span>Try searching</span>
              {staples.map((item) => (
                <Link href={`/?q=${encodeURIComponent(item.term)}#prices`} key={item.term}>{item.label}</Link>
              ))}
            </div>
          </section>
        </div>

        <section className="prices-section" id="prices">
          {error && (
            <div role="alert" className="data-alert">
              Price data is unavailable right now. Please try again soon.
            </div>
          )}
          {query ? (
            <>
              <div className="section-heading">
                <div>
                  <p className="section-label">Latest recorded prices</p>
                  <h2>Results for “{query}”</h2>
                  <p>
                    Each result is one store’s listing. Open one to see its price history.
                  </p>
                </div>
                <Link href="/" className="clear-search">Clear search <ArrowRight size={18} aria-hidden="true" /></Link>
              </div>
              {!error && (
                <>
                  <div className="results-toolbar">
                    <p className="result-count">
                      {prices.length}
                      {hasMore ? "+" : ""} result{prices.length === 1 ? "" : "s"}
                    </p>
                    {prices.length > 1 && <SortToggle query={query} sort={sort} />}
                  </div>
                  {prices.length > 0 ? (
                    <ul className="price-list">
                      {prices.map((row, index) => (
                        <PriceRow
                          key={row.product_id}
                          id={`result-${index}`}
                          row={row}
                          href={productHref(row.product_id)}
                          quantity={basket.get(row.product_id) ?? 0}
                          trend={histories.get(row.product_id)?.trend}
                          badge={histories.get(row.product_id)?.badge}
                        />
                      ))}
                    </ul>
                  ) : (
                    <div className="empty-state">
                      <p>No products found for “{query}”.</p>
                      <p>Try a simpler search, such as <Link href="/?q=milk#prices">milk</Link> or <Link href="/?q=banana#prices">banana</Link>.</p>
                    </div>
                  )}
                  {hasMore && (
                    <Link
                      className="show-more"
                      href={`${searchHref(query, sort, count + PAGE_SIZE)}#result-${count}`}
                      scroll={false}
                    >
                      Show more results <ArrowDown size={18} aria-hidden="true" />
                    </Link>
                  )}
                  {prices.some((row) => estimatedRegular(row) !== null) && (
                    <p className="price-note">* “Usually” is an approximate regular price inferred from that store’s unit price. The store does not label it as a sale.</p>
                  )}
                  {sort === "value" && prices.length > 0 && (
                    <p className="price-note">
                      Best value compares price per 100 g, per 100 ml, or each. Items with no unit price are listed last.
                    </p>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <div className="section-heading" id="how-it-works">
                <div>
                  <p className="section-label">The little things add up</p>
                  <h2>Shop a little smarter.</h2>
                  <p>A simpler way to see the prices behind your grocery list.</p>
                </div>
              </div>
              <div className="feature-grid">
                <article className="feature-card feature-card-yellow">
                  <ShoppingBasket size={36} strokeWidth={2.2} aria-hidden="true" />
                  <h3>Find a price</h3>
                  <p>
                    Search real listings from{" "}
                    {storeList.length > 1 ? `${storeList.length} Canadian grocery chains` : "Canadian grocery stores"},
                    cheapest first.
                  </p>
                  <Link href="/?q=milk#prices">Try a search <ArrowRight size={18} aria-hidden="true" /></Link>
                </article>
                <article className="feature-card feature-card-lilac">
                  <ChartNoAxesCombined size={36} strokeWidth={2.2} aria-hidden="true" />
                  <h3>See the history</h3>
                  <p>Every listing has a price graph, so you can tell a good price from a normal one.</p>
                  <Link href="/?q=cheddar#prices">Find a price graph <ArrowRight size={18} aria-hidden="true" /></Link>
                </article>
                <article className="feature-card feature-card-pink">
                  <Tag size={36} strokeWidth={2.2} aria-hidden="true" />
                  <h3>Price your basket</h3>
                  <p>Add your list and see which store is cheapest for all of it, plus similar items that cost less.</p>
                  <Link href="/basket">Open your basket <ArrowRight size={18} aria-hidden="true" /></Link>
                </article>
              </div>
              <div className="home-bottom">
                <div className="home-bottom-copy">
                  <p className="section-label">Start with a staple</p>
                  <h3>The best place to start is your own grocery list.</h3>
                  <p>Milk, cheese, bananas — search a staple and see the latest recorded listings.</p>
                  <div className="home-bottom-links">
                    {staples.map((item) => <Link key={item.term} href={`/?q=${encodeURIComponent(item.term)}#prices`}>{item.label}<ArrowRight size={17} aria-hidden="true" /></Link>)}
                  </div>
                </div>
                <div className="banana-card" aria-hidden="true">
                  <span>Good food.<br />Good sense.</span>
                  <Image src="/illustrations/bananas.png" alt="" width={245} height={245} />
                </div>
              </div>
            </>
          )}
        </section>

        {coverage.data && (
          <section className="coverage" aria-label="Data coverage">
            <p><strong>{coverage.data.products.toLocaleString("en-CA")}</strong><span>products tracked</span></p>
            <p><strong>{coverage.data.observations.toLocaleString("en-CA")}</strong><span>price observations</span></p>
            <p><strong>{coverage.data.days.toLocaleString("en-CA")}</strong><span>days of history</span></p>
            {storeList.length > 0 && (
              <p><strong>{storeList.length}</strong><span>stores checked nightly</span></p>
            )}
            {storeList.length > 0 && (
              <div className="coverage-stores">
                <p>One store per chain, checked every night. Prices differ between locations, so every price says where it was recorded.</p>
                <ul>
                  {storeList.map((store) => (
                    <li key={store.id} className="store-chip">
                      <i style={{ background: BANNER_COLORS[store.banner_slug] ?? "#53617e" }} aria-hidden="true" />
                      {BANNER_SHORT[store.banner_slug] ?? store.retailer_name}
                      {storeArea(store.label) && <span className="store-chip-area">{storeArea(store.label)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <SiteFooter />
      </div>
    </main>
  );
}
