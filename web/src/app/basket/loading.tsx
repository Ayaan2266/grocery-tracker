import { SearchForm } from "@/components/search-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/**
 * Shown the moment the basket is opened, while it looks up each item and then
 * the same items at every other store. The heading is the real one; the totals
 * and the list are placeholders in their places.
 */
export default function BasketLoading() {
  return (
    <main>
      <div className="site-shell" id="top">
        <div className="hero-wrap hero-wrap-compact">
          <SiteHeader current="basket" />
          <div className="compact-search">
            <SearchForm compact />
          </div>
        </div>

        <article className="basket-page" aria-busy="true">
          <p className="visually-hidden" role="status">Pricing your basket…</p>
          <div className="section-heading">
            <div>
              <p className="section-label">Your basket</p>
              <h1>Where is your list cheapest?</h1>
              <div className="skeleton skeleton-line" aria-hidden="true" />
            </div>
          </div>

          <section className="chart-card skeleton-section" aria-hidden="true">
            <div className="skeleton skeleton-heading" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line skeleton-line-short" />
          </section>
          <section className="chart-card skeleton-section" aria-hidden="true">
            <div className="skeleton skeleton-label" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line skeleton-line-short" />
          </section>
        </article>

        <SiteFooter />
      </div>
    </main>
  );
}
