"use client";

import { startTransition, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, RotateCcw } from "lucide-react";

import { HeaderBar } from "@/components/header-bar";
import { SiteFooter } from "@/components/site-footer";

/**
 * Anything a page throws. Queries return their errors rather than throwing
 * (lib/queries.ts), so this is for the unexpected. In production Next replaces
 * the message with a digest, which is shown so a report can be matched to the
 * server log.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  useEffect(() => {
    console.error(error);
  }, [error]);

  // The page renders on the server, so trying again means asking the server
  // for it again (refresh), then clearing this boundary (reset).
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });

  return (
    <main>
      <div className="site-shell" id="top">
        <div className="hero-wrap hero-wrap-compact">
          <HeaderBar />
        </div>

        <article className="status-page">
          <Link href="/" className="back-link">
            <ArrowLeft size={18} aria-hidden="true" />
            Back to search
          </Link>
          <p className="section-label">Something went wrong</p>
          <h1>This page didn’t load.</h1>
          <div role="alert" className="data-alert">
            Loonie hit an error putting this page together. Trying again usually works.
          </div>
          <div className="status-actions">
            <button type="button" className="outline-button" onClick={retry}>
              <RotateCcw size={16} aria-hidden="true" />
              Try again
            </button>
            <Link href="/" className="outline-button">Go to search</Link>
          </div>
          {error.digest && <p className="price-note">Reference: {error.digest}</p>}
        </article>

        <SiteFooter />
      </div>
    </main>
  );
}
