import Image from "next/image";
import Link from "next/link";
import { ShoppingBasket } from "lucide-react";

import { readBasket } from "@/lib/basket";

export async function SiteHeader() {
  const basket = await readBasket();
  const items = basket.size;

  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="Loonie home">
        <Image src="/brand/loonie-mark.svg" alt="" width={48} height={48} priority />
        <span>Loonie</span>
      </Link>
      <nav aria-label="Main navigation">
        <Link href="/#prices">Prices</Link>
        <Link href="/#how-it-works">How it works</Link>
        <Link href="/basket" className="basket-link">
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
