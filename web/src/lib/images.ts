/**
 * Product photos.
 *
 * No imports, so `npm test` can run it on plain Node without a bundler.
 *
 * The nightly run keeps one link per product, the store's first photo at
 * 400 px (ingest/normalize.py extract_image_url, db/migrations/0017). The
 * store serves every photo at five widths that differ only in the end of the
 * file name, "..._en_1_400.png" against "..._en_1_120.png", so a list row asks
 * for the small one and the product page for a bigger one. A link that does
 * not end that way is used as it is.
 *
 * The photo loads straight from the store's image server, not through this
 * site: nothing is copied or stored here but the link.
 */

/** The widths the store serves, in pixels. */
export const PHOTO_WIDTHS = [120, 250, 400, 800, 1200] as const;
export type PhotoWidth = (typeof PHOTO_WIDTHS)[number];

const SIZED = /_(?:120|250|400|800|1200)\.png$/;

/**
 * The photo at `width`, or null when there is no usable link. Only an https
 * link is shown; the database should hold nothing else, and this is the last
 * stop before an <img>.
 */
export function photoUrl(url: string | null | undefined, width: PhotoWidth): string | null {
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  return SIZED.test(url) ? url.replace(SIZED, `_${width}.png`) : url;
}
