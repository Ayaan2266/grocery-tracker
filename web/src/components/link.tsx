"use client";

import NextLink from "next/link";
import { useState, type ComponentProps } from "react";

type Props = Omit<ComponentProps<typeof NextLink>, "prefetch"> & {
  /**
   * Load the page as soon as the visitor points at, focuses or touches the
   * link, so it opens at once. For the few links most visitors follow: the
   * header's.
   */
  warm?: boolean;
};

/**
 * The site's link. Next's own, except that it does not load the page it
 * points to until asked.
 *
 * Next prefetches every link that scrolls into view, and each prefetch of one
 * of these pages runs a server function, because they all read the visitor's
 * basket and store cookies. A page of search results has sixty product links
 * on it and the header four more, so one visit ran dozens of functions, and
 * the header's fetched four whole pages, the price changes among them. Nearly
 * all of that was for pages nobody opened.
 *
 * So nothing is prefetched for being visible. A `warm` link is prefetched in
 * full the moment the visitor shows they mean to follow it; any other link
 * loads when clicked, with the progress bar (navigation-progress.tsx) to show
 * for it. With JavaScript off this is a plain link either way.
 */
export default function Link({ warm = false, onPointerEnter, onFocus, onTouchStart, ...props }: Props) {
  const [wanted, setWanted] = useState(false);
  if (!warm) return <NextLink prefetch={false} {...props} />;
  return (
    <NextLink
      {...props}
      prefetch={wanted}
      onPointerEnter={(event) => {
        setWanted(true);
        onPointerEnter?.(event);
      }}
      onFocus={(event) => {
        setWanted(true);
        onFocus?.(event);
      }}
      onTouchStart={(event) => {
        setWanted(true);
        onTouchStart?.(event);
      }}
    />
  );
}
