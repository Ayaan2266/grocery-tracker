import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shelf Smart | Grocery prices have a story",
  description:
    "Search recorded Canadian grocery prices, see store sale context, and shop a little smarter.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      {/*
        System font stack rather than next/font + Google Fonts. next/font
        fetches at build time, which makes every CI run and every Vercel
        deploy depend on fonts.googleapis.com being reachable. Not worth an
        external point of failure for a typeface nobody will comment on.
      */}
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
