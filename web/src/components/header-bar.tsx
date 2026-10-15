import Image from "next/image";
import Link from "next/link";
import { ShoppingBasket } from "lucide-react";

export type HeaderPage = "home" | "changes" | "how-it-works" | "basket";

/**
 * The header itself, given the basket count. SiteHeader reads the count from
 * the cookie; the error page cannot, being a client component, so it renders
 * this without one.
 */
export function HeaderBar({ current, items = 0 }: { current?: HeaderPage; items?: number }) {
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="Loonie home">
        <Image src="/brand/loonie-mark.svg" alt="" width={48} height={48} priority />
        <span>Loonie</span>
      </Link>
      <nav aria-label="Main navigation">
        <Link href="/" aria-current={current === "home" ? "page" : undefined}>Home</Link>
        {/* "Changes" on a phone, where three links have to fit beside the brand. */}
        <Link href="/changes" aria-current={current === "changes" ? "page" : undefined}>
          <span className="nav-long">Price changes</span>
          <span className="nav-short" aria-hidden="true">Changes</span>
        </Link>
        <Link href="/how-it-works" aria-current={current === "how-it-works" ? "page" : undefined}>
          How it works
        </Link>
        <Link href="/basket" className="basket-link" aria-current={current === "basket" ? "page" : undefined}>
          <ShoppingBasket size={18} aria-hidden="true" />
          Basket
          {items > 0 && (
            <span className="basket-count" aria-label={`${items} item${items === 1 ? "" : "s"}`}>
              {items}
            </span>
          )}
        </Link>
      </nav>
      <span className="header-note">Made for Canadian shoppers <span aria-hidden="true">♥</span></span>
    </header>
  );
}
