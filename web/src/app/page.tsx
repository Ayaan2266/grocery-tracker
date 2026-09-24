import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChartNoAxesCombined, Search, ShoppingBasket, Tag } from "lucide-react";
import { getCoverage, searchProducts, type LatestPrice } from "@/lib/queries";
import { formatCents, formatDay, formatUnitPrice } from "@/lib/utils";

const BANNER_LABELS: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Real Canadian Superstore",
  loblaw: "Loblaws",
};

const staples = [
  { label: "Milk", term: "milk" },
  { label: "Cheddar", term: "cheddar" },
  { label: "Bananas", term: "banana" },
];

function estimatedRegular(row: LatestPrice): number | null {
  return row.was_price_cents === null ? (row.implied_regular_cents ?? null) : null;
}

function SearchForm({ query }: { query: string }) {
  return (
    <form action="/" method="get" role="search" className="search-form">
      <Search size={25} strokeWidth={2} aria-hidden="true" />
      <input
        type="search"
        name="q"
        defaultValue={query}
        placeholder="Search milk, cheddar, bananas..."
        aria-label="Search grocery prices"
        enterKeyHint="search"
      />
      <button type="submit" aria-label="Search prices">
        <span>Search prices</span>
        <ArrowRight size={21} aria-hidden="true" />
      </button>
    </form>
  );
}

function PriceRow({ row }: { row: LatestPrice }) {
  const estimated = estimatedRegular(row);
  const unitPrice = formatUnitPrice(
    row.unit_price_cents,
    row.comparison_quantity,
    row.comparison_unit,
  );

  return (
    <li className="price-row">
      <div className="price-row-product">
        <h3>{row.raw_name}</h3>
        <p>{[row.brand, row.package_size].filter(Boolean).join(" · ") || "Grocery item"}</p>
      </div>
      <div className="price-row-store">
        <strong>{BANNER_LABELS[row.banner_slug] ?? row.retailer_name}</strong>
        <span>Recorded {formatDay(row.observed_on)}</span>
      </div>
      <div className="price-row-amount">
        <strong>{formatCents(row.price_cents)}</strong>
        {row.was_price_cents !== null && (
          <span className="sale-label">Store sale · was {formatCents(row.was_price_cents)}</span>
        )}
        {estimated !== null && (
          <span className="estimate-label" title="Estimated from the store's own unit price. The store does not mark this as a sale.">
            Usually ~{formatCents(estimated)}*
          </span>
        )}
        {unitPrice && <span>{unitPrice}</span>}
        {!row.in_stock && <span className="stock-label">Out of stock</span>}
      </div>
    </li>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q = "" } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const [results, coverage] = await Promise.all([searchProducts(query), getCoverage()]);
  const prices = results.data ?? [];
  const error = results.error ?? (!query ? coverage.error : null);

  return (
    <main>
      <a className="skip-link" href="#prices">Skip to prices</a>
      <div className="site-shell" id="top">
        <div className="hero-wrap">
        <header className="site-header">
          <Link className="brand" href="/" aria-label="Loonie home">
            <Image src="/brand/loonie-mark.svg" alt="" width={48} height={48} priority />
            <span>Loonie</span>
          </Link>
          <nav aria-label="Main navigation">
            <a href="#prices">Prices</a>
            <a href={query ? "/#how-it-works" : "#how-it-works"}>How it works</a>
          </nav>
          <span className="header-note">Made for Canadian shoppers <span aria-hidden="true">♥</span></span>
        </header>

        <section className="hero" aria-labelledby="hero-title">
          <Image className="hero-tote" src="/illustrations/grocery-tote.png" alt="" width={350} height={350} priority />
          <p className="eyebrow">Same groceries. Smarter choices. <span aria-hidden="true">✦</span></p>
          <h1 id="hero-title">Grocery prices have a story<span className="gold-stop">.</span></h1>
          <p className="hero-description">
            Find out if today is a good day to buy.
          </p>
          <SearchForm query={query} />
          <div className="staples" aria-label="Try a staple">
            <span>Try searching</span>
            {staples.map((item) => (
              <Link href={"/?q=" + encodeURIComponent(item.term)} key={item.term}>{item.label}</Link>
            ))}
          </div>
        </section>
        </div>

        {error && (
          <div role="alert" className="data-alert">
            Price data is unavailable right now. Please try again soon.
          </div>
        )}

        <section className="prices-section" id="prices">
          {query ? (
            <>
              <div className="section-heading">
                <div>
                  <p className="section-label">Latest recorded prices</p>
                  <h2>Results for “{query}”</h2>
                  <p>Each result is an individual store listing, sorted by price.</p>
                </div>
                <Link href="/" className="clear-search">Clear search <ArrowRight size={18} aria-hidden="true" /></Link>
              </div>
              {!error && (
                <>
                  <p className="result-count">{prices.length} result{prices.length === 1 ? "" : "s"}</p>
                  {prices.length > 0 ? (
                    <ul className="price-list">{prices.map((row) => <PriceRow key={row.product_id} row={row} />)}</ul>
                  ) : (
                    <div className="empty-state">
                      <p>No products found for “{query}”.</p>
                      <p>Try a simpler search, such as <Link href="/?q=milk">milk</Link> or <Link href="/?q=banana">banana</Link>.</p>
                    </div>
                  )}
                  {prices.some((row) => estimatedRegular(row) !== null) && (
                    <p className="price-note">* “Usually” is an approximate regular price inferred from that store’s unit price. The store does not label it as a sale.</p>
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
                  <p>Search real grocery listings from Canadian stores.</p>
                  <Link href="/?q=milk">Try a search <ArrowRight size={18} aria-hidden="true" /></Link>
                </article>
                <article className="feature-card feature-card-lilac">
                  <ChartNoAxesCombined size={36} strokeWidth={2.2} aria-hidden="true" />
                  <h3>See the context</h3>
                  <p>Check when a price was recorded and which store listed it.</p>
                  <span>Clarity at a glance</span>
                </article>
                <article className="feature-card feature-card-pink">
                  <Tag size={36} strokeWidth={2.2} aria-hidden="true" />
                  <h3>Spot a sale</h3>
                  <p>Sale labels stay clear, so you know what is actually marked down.</p>
                  <span>Smarter choices</span>
                </article>
              </div>
              <div className="home-bottom">
                <div className="home-bottom-copy">
                  <p className="section-label">Start with a staple</p>
                  <h3>The best place to start is your own grocery list.</h3>
                  <p>Milk, cheese, bananas — search a staple and see the latest recorded listings.</p>
                  <div className="home-bottom-links">
                    {staples.map((item) => <Link key={item.term} href={"/?q=" + encodeURIComponent(item.term)}>{item.label}<ArrowRight size={17} aria-hidden="true" /></Link>)}
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
          </section>
        )}

        <footer id="about" className="site-footer">
          <div className="footer-brand"><Image src="/brand/loonie-mark.svg" alt="" width={28} height={28} /><strong>Loonie</strong></div>
          <p>Independent, non-commercial project. Prices are recorded snapshots, not checkout quotes. Not affiliated with any retailer.</p>
          <a href="#top">Back to top ↑</a>
        </footer>
      </div>
    </main>
  );
}
