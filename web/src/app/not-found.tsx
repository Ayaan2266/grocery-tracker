import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { SearchForm } from "@/components/search-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Page not found | Loonie" };

/** Any unknown address, and a product id that does not exist (notFound()). */
export default function NotFound() {
  return (
    <main>
      <div className="site-shell" id="top">
        <div className="hero-wrap hero-wrap-compact">
          <SiteHeader />
          <div className="compact-search">
            <SearchForm compact />
          </div>
        </div>

        <article className="status-page">
          <Link href="/" className="back-link">
            <ArrowLeft size={18} aria-hidden="true" />
            Back to search
          </Link>
          <p className="section-label">Page not found</p>
          <h1>That page isn’t here.</h1>
          <div className="empty-state">
            <p>The link may be mistyped, or it may point to a product Loonie does not track.</p>
            <p>
              Search above, or start with a staple: <Link href="/?q=milk#prices">milk</Link>,{" "}
              <Link href="/?q=cheddar#prices">cheddar</Link> or <Link href="/?q=banana#prices">bananas</Link>.
            </p>
          </div>
        </article>

        <SiteFooter />
      </div>
    </main>
  );
}
