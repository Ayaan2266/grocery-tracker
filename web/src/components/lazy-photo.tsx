"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

// How far ahead of the screen a photo starts loading: about three list rows,
// so it is usually in place by the time its row scrolls into view. The
// browser's own loading="lazy" starts 1250 to 2500 px ahead, which on a long
// list of results still fetches dozens of photos nobody scrolls to.
const AHEAD = "200px 0px";

/**
 * A list photo that is only fetched once it comes near the screen. Until
 * then it is an empty box of the same size, so rows do not move when the
 * photo arrives. Where IntersectionObserver is missing the photo loads
 * straight away.
 */
export function LazyPhoto({ src, size, className }: { src: string; size: number; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: AHEAD },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  if (!near) return <span ref={ref} className={className} aria-hidden="true" />;
  return <Image src={src} alt="" width={size} height={size} unoptimized loading="eager" className={className} />;
}
