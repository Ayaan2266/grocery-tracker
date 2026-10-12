import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site";

/**
 * The fixed pages. Product pages are left out: there are over 50,000 and they
 * are all linked from search results, which crawlers follow without a list.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return [
    { url: new URL("/", base).toString(), changeFrequency: "daily", priority: 1 },
    { url: new URL("/how-it-works", base).toString(), changeFrequency: "weekly", priority: 0.6 },
  ];
}
