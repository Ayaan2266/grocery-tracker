import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site";

/**
 * Everything is open to crawlers except the basket, which is one browser's
 * cookie and the same empty page to anyone else.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/basket" },
    sitemap: new URL("/sitemap.xml", siteUrl()).toString(),
  };
}
