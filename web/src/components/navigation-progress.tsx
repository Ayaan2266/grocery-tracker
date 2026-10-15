"use client";

import { useEffect, useRef } from "react";

/**
 * The thin blue bar across the top of the window while a page is on its way:
 * after a link is followed, a search is made, or a form changes the basket or
 * the stores shown. Every page renders on the server, so without it a slow
 * click looks like nothing happened.
 *
 * It starts on the click or submit and finishes when the router commits the
 * new page, which it always marks by writing browser history. If the page
 * arrived as a loading placeholder (anything marked aria-busy, like
 * product/[id]/loading.tsx), the bar keeps going until the real page replaces
 * it. Quick navigations finish before SHOW_AFTER_MS and never show it at all.
 */
const SHOW_AFTER_MS = 120;
const TRICKLE_MS = 250;
/** A navigation that never reports back must not leave the bar up forever. */
const GIVE_UP_MS = 20_000;
const FINISH_EVENT = "loonie:progress-done";

const historyListeners = new Set<() => void>();
let historyPatched = false;

/**
 * Next writes history once per committed router state, for navigations and
 * for server actions that revalidate alike. Patched once and never undone, so
 * React's strict-mode double effects cannot unpatch Next's own wrapper.
 */
function watchHistory(listener: () => void): () => void {
  if (!historyPatched) {
    historyPatched = true;
    for (const method of ["pushState", "replaceState"] as const) {
      const original = window.history[method];
      window.history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        original.apply(this, args);
        for (const notify of historyListeners) notify();
      };
    }
  }
  historyListeners.add(listener);
  return () => historyListeners.delete(listener);
}

/**
 * Finish the bar by hand, for a form action that can end without changing the
 * page (a postal code that could not be found, say).
 */
export function finishNavigationProgress(): void {
  window.dispatchEvent(new Event(FINISH_EVENT));
}

function withoutHash(url: URL): string {
  return url.href.slice(0, url.href.length - url.hash.length);
}

/** A same-site link the router will handle, to somewhere other than here. */
function isNavigation(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return false;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  // A skip link or "Back to top" scrolls; it does not load anything.
  return withoutHash(url) !== withoutHash(new URL(window.location.href));
}

export function NavigationProgress() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return;

    let active = false;
    let progress = 0;
    let timers: number[] = [];
    let trickle: number | undefined;
    let observer: MutationObserver | null = null;

    const clearTimers = () => {
      for (const id of timers) window.clearTimeout(id);
      timers = [];
      window.clearInterval(trickle);
      observer?.disconnect();
      observer = null;
    };
    const paint = (state: "idle" | "loading" | "finishing") => {
      element.dataset.state = state;
      element.style.setProperty("--progress", `${progress}%`);
    };

    const start = () => {
      if (active) return;
      clearTimers();
      active = true;
      progress = 0;
      paint("idle");
      timers.push(
        window.setTimeout(() => {
          progress = 12;
          paint("loading");
          // Fast at first, then ever slower, never reaching the end on its own.
          trickle = window.setInterval(() => {
            progress += (90 - progress) * 0.1;
            paint("loading");
          }, TRICKLE_MS);
        }, SHOW_AFTER_MS),
        window.setTimeout(() => finish(), GIVE_UP_MS),
      );
    };

    const finish = () => {
      if (!active) return;
      active = false;
      const shown = element.dataset.state === "loading";
      clearTimers();
      if (!shown) {
        paint("idle");
        return;
      }
      progress = 100;
      paint("finishing");
      timers.push(window.setTimeout(() => {
        progress = 0;
        paint("idle");
      }, 400));
    };

    /** Finish now, or once the loading placeholder on screen is replaced. */
    const settle = () => {
      if (!active) return;
      // The history write comes mid-commit; look once the new page is in.
      window.requestAnimationFrame(() => {
        if (!active) return;
        if (!document.querySelector('[aria-busy="true"]')) {
          finish();
          return;
        }
        observer?.disconnect();
        observer = new MutationObserver(() => {
          if (!document.querySelector('[aria-busy="true"]')) finish();
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
      });
    };

    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (anchor instanceof HTMLAnchorElement && isNavigation(event, anchor)) start();
    };
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && (!form.target || form.target === "_self")) start();
    };

    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    window.addEventListener(FINISH_EVENT, finish);
    const unwatch = watchHistory(settle);
    return () => {
      clearTimers();
      document.removeEventListener("click", onClick);
      document.removeEventListener("submit", onSubmit);
      window.removeEventListener(FINISH_EVENT, finish);
      unwatch();
    };
  }, []);

  return (
    <div ref={root} className="nav-progress" data-state="idle" aria-hidden="true">
      <div className="nav-progress-bar" />
    </div>
  );
}
