import { SearchForm } from "@/components/search-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/**
 * Shown the moment a product link is followed, while the page makes its
 * queries: the product, then the same item at other stores, then every one's
 * history. The real page's cards in the real page's places, so nothing jumps
 * when it arrives.
 */
export default function ProductLoading() {
  return (
    <main>
      <div className="site-shell" id="top">
        <div className="hero-wrap hero-wrap-compact">
          <SiteHeader />
          <div className="compact-search">
            <SearchForm compact />
          </div>
        </div>

        <article className="product-page" aria-busy="true">
          <p className="visually-hidden" role="status">Loading price history…</p>
          <div className="skeleton skeleton-link" />
          <header className="product-heading" aria-hidden="true">
            <div className="skeleton skeleton-chip" />
            <div className="skeleton skeleton-title" />
            <div className="skeleton skeleton-line" />
          </header>

          <div className="product-grid" aria-hidden="true">
            <section className="price-card">
              <div className="skeleton skeleton-label" />
              <div className="skeleton skeleton-amount" />
              <div className="skeleton skeleton-line" />
              <div className="skeleton skeleton-button" />
            </section>
            <section className="verdict-card">
              <div className="skeleton skeleton-label" />
              <div className="skeleton skeleton-heading" />
              <div className="skeleton skeleton-line" />
              <div className="skeleton skeleton-line skeleton-line-short" />
            </section>
          </div>

          <section className="chart-card" aria-hidden="true">
            <div className="skeleton skeleton-heading" />
            <div className="skeleton skeleton-chart" />
          </section>
        </article>

        <SiteFooter />
      </div>
    </main>
  );
}
