import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

/**
 * Sent with every response. The site embeds nothing and is embedded nowhere,
 * so framing is refused outright, and a URL with a search in it is not handed
 * to other sites in full.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
  poweredByHeader: false,
  images: {
    // AVIF first: the illustrations are flat colour, where it is far smaller
    // than WebP. The art only changes with a new file name (see the comment on
    // the receipt in app/how-it-works/page.tsx), so it can be cached for a month.
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
