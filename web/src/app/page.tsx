import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChartNoAxesCombined, Heart, Search, ShoppingCart, Sparkles, Tag } from "lucide-react";
import { getCoverage, searchProducts, type LatestPrice } from "@/lib/queries";
import { formatCents, formatDay, formatUnitPrice } from "@/lib/utils";

const BANNERS: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Real Canadian Superstore",
  loblaw: "Loblaws",
};
const suggestions = [
  { name: "Milk", term: "milk", emoji: "🥛", note: "A fridge staple" },
  { name: "Cheddar", term: "cheddar", emoji: "🧀", note: "For every meal" },
  { name: "Bananas", term: "banana", emoji: "🍌", note: "The weekly bunch" },
];

function estimatedRegular(row: LatestPrice): number | null {
  return row.was_price_cents === null ? (row.implied_regular_cents ?? null) : null;
}

function PriceRow({ row }: { row: LatestPrice }) {
  const estimated = estimatedRegular(row);
  const unitPrice = formatUnitPrice(row.unit_price_cents, row.comparison_quantity, row.comparison_unit);
  return (
    <li className="price-row">
      <div className="price-product">
        <span className="product-icon" aria-hidden="true">✱</span>
        <div className="product-copy">
          <h3>{row.raw_name}</h3>
          <p>{[row.brand, row.package_size].filter(Boolean).join(" · ") || "Grocery item"}</p>
        </div>
      </div>
      <div className="price-store">
        <strong>{BANNERS[row.banner_slug] ?? row.retailer_name}</strong>
        <span>Recorded {formatDay(row.observed_on)}</span>
      </div>
      <div className="price-value">
        <strong>{formatCents(row.price_cents)}</strong>
        {row.was_price_cents !== null && <span className="sale-context">Store sale · was {formatCents(row.was_price_cents)}</span>}
        {estimated !== null && <span className="sale-context" title="Estimated from the store's own unit price. The store does not mark this as a sale.">Usually ~{formatCents(estimated)}*</span>}
        {unitPrice && <span>{unitPrice}</span>}
        {!row.in_stock && <span className="stock-status">Out of stock</span>}
      </div>
    </li>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q = "" } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const [results, coverage] = await Promise.all([searchProducts(query), getCoverage()]);
  const failure = results.error ?? coverage.error;
  const prices = results.data ?? [];

  return (
    <main>
      <section className="hero" id="top">
        <header className="site-header page-shell">
          <Link className="brand" href="/" aria-label="Shelf Smart home"><span>SHELF</span><span>SMART<b>✱</b></span></Link>
          <p className="brand-promise">Same groceries.<br />Smarter choices.<br /><em>A brighter Canada.</em></p>
          <nav className="main-nav" aria-label="Main navigation"><a href="#prices">Prices</a><a href="#how-it-works">How it works</a><a href="#about">About</a></nav>
          <div className="header-note"><Heart size={25} fill="currentColor" aria-hidden="true" /><span>A more affordable<br />Canada, together.</span></div>
        </header>
        <Image className="hero-groceries" src="/illustrations/grocery-tote.png" alt="Illustrated grocery bag filled with vegetables and bananas" width={620} height={620} priority sizes="(max-width: 760px) 180px, 330px" />
        <div className="hero-content page-shell">
          <p className="hero-eyebrow">✱ &nbsp; A little brighter at checkout</p>
          <h1>Grocery prices<br />have a story.</h1>
          <p className="hero-subtitle">Find out if today is a good day to buy.</p>
          <form action="/" method="get" role="search" className="search-form">
            <Search size={28} strokeWidth={2.6} aria-hidden="true" />
            <input type="search" name="q" defaultValue={query} placeholder="Search groceries..." aria-label="Search grocery prices" enterKeyHint="search" />
            <button type="submit" aria-label="Find prices"><span>Find prices</span><ArrowRight size={24} aria-hidden="true" /></button>
          </form>
          <p className="search-hint">Milk, cheese, bananas… find it, track it, shop a little smarter.</p>
        </div>
        <p className="hero-scribble" aria-hidden="true">SAME GROCERIES.<br />BRIGHTER TOMORROWS.</p>
        <div className="hero-sticker" aria-hidden="true">SMART<br />SHOPPERS<br />STRONGER<br />CANADA<br /><span>✱</span></div>
      </section>

      <div className="page-shell body-shell">
        <section className="feature-grid" id="how-it-works" aria-label="What Shelf Smart shows you">
          <article className="feature-card yellow-card">
            <ShoppingCart className="feature-icon red" size={50} strokeWidth={2.8} aria-hidden="true" />
            <div><h2>Search store prices</h2><p>See the latest recorded listings from three Canadian grocery banners.</p></div>
            <div className="store-pills"><span>No Frills</span><span>Superstore</span><span>Loblaws</span></div>
          </article>
          <article className="feature-card lilac-card">
            <ChartNoAxesCombined className="feature-icon" size={50} strokeWidth={2.8} aria-hidden="true" />
            <div><h2>History in the making</h2><p>Daily price records are building a clearer picture over time.</p></div>
            <div className="history-art" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
          </article>
          <article className="feature-card pink-card">
            <Tag className="feature-icon red" size={50} strokeWidth={2.8} aria-hidden="true" />
            <div><h2>Spot a real deal</h2><p>See store sale prices and clearly marked estimates for unmarked deals.</p></div>
            <div className="deal-note"><Sparkles size={23} aria-hidden="true" /> Better context. Better choices.</div>
          </article>
        </section>

        {failure && <div role="alert" className="database-alert">Price data is unavailable right now. {failure}</div>}

        <section className="prices-section" id="prices">
          <div className="section-heading">
            <div><p className="section-kicker">THE GOOD STUFF <span>✱</span></p><h2>{query ? "Prices for “" + query + "”" : "Start with the staples"}</h2><p>{query ? "Latest recorded listings, cheapest first. Each row is one store product." : "Pick something familiar and see what the stores are charging."}</p></div>
            {query && <Link className="clear-search" href="/">New search <ArrowRight size={19} aria-hidden="true" /></Link>}
          </div>
          {query && !failure && <>
            <p className="result-count">{prices.length === 0 ? "No matching products yet." : prices.length + " result" + (prices.length === 1 ? "" : "s") + " found"}</p>
            {prices.length > 0 && <ul className="price-list">{prices.map((row) => <PriceRow key={row.product_id} row={row} />)}</ul>}
            {prices.some((row) => estimatedRegular(row) !== null) && <p className="price-footnote">* “Usually” is an approximate regular price inferred from that store’s unit price. The store does not label it as a sale.</p>}
            {prices.length === 0 && <p className="empty-state">Try a simpler name, such as <Link href="/?q=milk">milk</Link> or <Link href="/?q=banana">banana</Link>.</p>}
          </>}
          {!query && <div className="home-lower-grid">
            <div className="suggestion-list">{suggestions.map((item) => <Link className="suggestion-row" href={"/?q=" + encodeURIComponent(item.term)} key={item.term}><span className="suggestion-emoji" aria-hidden="true">{item.emoji}</span><span className="suggestion-copy"><strong>{item.name}</strong><small>{item.note}</small></span><span className="suggestion-action">Check prices <ArrowRight size={19} aria-hidden="true" /></span></Link>)}</div>
            <aside className="banana-card"><p>SAME GROCERIES.<br />BRIGHTER<br />TOMORROWS. <span>♥</span></p><Image src="/illustrations/bananas.png" alt="Illustrated bunch of bananas" width={300} height={300} sizes="(max-width: 760px) 180px, 260px" /><span className="banana-stamp">GOOD THINGS<br />COST LESS<br />HERE ✱</span></aside>
          </div>}
        </section>

        <section className="coverage-band" aria-label="Data coverage">
          <div><span>✱</span><strong>{coverage.data?.days ?? "—"}</strong><small>days of history</small></div>
          <div><span>↗</span><strong>{coverage.data?.products.toLocaleString("en-CA") ?? "—"}</strong><small>products tracked</small></div>
          <div><span>♡</span><strong>{coverage.data?.observations.toLocaleString("en-CA") ?? "—"}</strong><small>price observations</small></div>
        </section>
        <footer className="site-footer" id="about"><div><strong>SHELF SMART<span>✱</span></strong><p>Same groceries. Smarter choices.</p></div><p>Independent, non-commercial project. Prices are recorded snapshots, not live checkout quotes. Not affiliated with any retailer.</p><a href="#top">Back to top ↑</a></footer>
      </div>
    </main>
  );
}
