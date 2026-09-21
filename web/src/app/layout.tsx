import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Canadian Grocery Price History",
  description:
    "Daily store-level grocery price history across Canadian banners. Tells you whether today's price is actually a good deal.",
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
