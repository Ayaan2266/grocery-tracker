import Image from "next/image";
import Link from "next/link";

export function SiteFooter() {
  return (
    <footer id="about" className="site-footer">
      <div className="footer-brand">
        <Image src="/brand/loonie-mark.svg" alt="" width={28} height={28} />
        <strong>Loonie</strong>
      </div>
      <p>
        Independent, non-commercial project. Prices are recorded snapshots, not checkout quotes.
        Not affiliated with any retailer.
      </p>
      <nav className="footer-links" aria-label="Footer">
        <Link href="/how-it-works">How Loonie works</Link>
        <a href="#top">Back to top ↑</a>
      </nav>
    </footer>
  );
}
