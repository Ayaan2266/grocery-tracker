import type { Metadata } from "next";
import "@fontsource-variable/dm-sans/wght.css";
import "./globals.css";

import { NavigationProgress } from "@/components/navigation-progress";
import { BASE_OPEN_GRAPH, SITE_DESCRIPTION, SITE_NAME, siteUrl } from "@/lib/site";

const TITLE = "Loonie | Know what groceries cost";

// The preview image itself is app/opengraph-image.tsx, which every page inherits.
export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: TITLE,
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: { ...BASE_OPEN_GRAPH, title: TITLE, description: SITE_DESCRIPTION },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      {/* Extensions such as Grammarly add attributes to <body> before React
          hydrates. This silences only <body>'s own attributes, not its children. */}
      <body suppressHydrationWarning>
        <NavigationProgress />
        {children}
      </body>
    </html>
  );
}
