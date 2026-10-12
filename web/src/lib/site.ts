import type { Metadata } from "next";

export const SITE_NAME = "Loonie";

export const SITE_DESCRIPTION =
  "Nightly price history from Canadian grocery stores. See whether today's price is " +
  "actually a good deal, and which store is cheapest for your whole basket.";

/**
 * The site's public address, for absolute links: preview images, robots.txt
 * and the sitemap. SITE_URL wins, for a custom domain; then the production
 * domain Vercel sets on every deployment; then local development.
 */
export function siteUrl(): URL {
  const explicit = process.env.SITE_URL;
  if (explicit) return new URL(explicit);
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return new URL(vercel ? `https://${vercel}` : `http://localhost:${process.env.PORT || 3000}`);
}

/** The link-preview card, drawn by app/opengraph-image.tsx. */
export const PREVIEW_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Loonie: grocery prices have a story. Nightly price history from Canadian grocery stores.",
};

/**
 * Open Graph fields every page shares. A page that sets its own `openGraph`
 * replaces the layout's whole object, the image from opengraph-image.tsx
 * included, rather than merging into it. So the image is named here too, and
 * such a page spreads this in.
 */
export const BASE_OPEN_GRAPH = {
  type: "website",
  siteName: SITE_NAME,
  locale: "en_CA",
  images: [PREVIEW_IMAGE],
} satisfies Metadata["openGraph"];
