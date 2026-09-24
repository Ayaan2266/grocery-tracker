import type { Metadata } from "next";
import "@fontsource-variable/dm-sans/wght.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loonie | Know what groceries cost",
  description:
    "Search recorded Canadian grocery prices and see clear store and sale context with Loonie.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
