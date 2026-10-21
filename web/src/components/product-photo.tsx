import Image from "next/image";

import { photoUrl } from "@/lib/images";

const VARIANTS = {
  // A list row: shown at 56 px, so the store's 120 px file covers a 2x screen.
  thumb: { size: 56, file: 120 },
  // Inside a line of text, like the basket's "Similar for less".
  mini: { size: 32, file: 120 },
  // The product page: shown at up to 160 px, so 400 px covers a 2.5x screen.
  large: { size: 160, file: 400 },
} as const;

/**
 * A product's photo, loaded straight from the store's image server
 * (lib/images.ts). Unoptimized on purpose: the store already serves each
 * photo at the size asked for, and Vercel's free plan only resizes so many
 * images a month. Without a photo a list thumbnail is an empty tile of the
 * same size, so rows still line up; the others are left out. The alt text
 * is empty because the product's name is always right beside it.
 */
export function ProductPhoto({
  url,
  variant,
}: {
  url: string | null | undefined;
  variant: keyof typeof VARIANTS;
}) {
  const { size, file } = VARIANTS[variant];
  const src = photoUrl(url, file);
  const className = `product-photo is-${variant}`;
  if (!src) return variant === "thumb" ? <span className={`${className} is-empty`} aria-hidden="true" /> : null;
  return (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      unoptimized
      priority={variant === "large"}
      className={className}
    />
  );
}
