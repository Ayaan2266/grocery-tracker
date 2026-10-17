import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowRight } from "lucide-react";

import { ChangeRow } from "@/components/change-row";
import { SearchForm } from "@/components/search-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { StoreDot, StoreScopeControl, storeScopeHelp } from "@/components/store-scope";
import { readBasket } from "@/lib/basket-server";
import { getPriceChangeCountsCached, getPriceChangesCached } from "@/lib/cached-queries";
import {
  changesHref,
  dayHeading,
  isFlyerNight,
  latestChangeDay,
  parseDirection,
  parseStoreFilter,
  percentText,
  tally,
  type Direction,
  type PriceChange,
} from "@/lib/changes";
import { CHANGES_PAGE_SIZE, MAX_RESULTS } from "@/lib/queries";
import { loadScopedStores } from "@/lib/store-scope";
import { BANNER_SHORT, storeArea, storeName } from "@/lib/stores";

export const metadata: Metadata = {
  title: "Price changes | Loonie",
  description: "Every grocery shelf price that went up or down overnight, biggest change first.",
};

type SearchParams = { dir?: string | string[]; store?: string | string[]; n?: string | string[] };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const count = (n: number) => n.toLocaleString("en-CA");

/** Items sold by weight listed under the main list, biggest change first. */
const WEIGHED_SHOWN = 12;

/** "Biggest: Old Cheddar at Loblaws Toronto Carlton Street, down 31%." */
function biggest(change: PriceChange | undefined): string | null {
  if (!change) return null;
  const area = storeArea(change.store_label);
  const banner = BANNER_SHORT[change.banner_slug] ?? change.retailer_name;
  const where = area ? `${banner} ${area}` : banner;
  const direction = change.change_cents < 0 ? "down" : "up";
  return `Biggest: ${change.raw_name} at ${where}, ${direction} ${percentText(change.change_percent)}.`;
}

export default async function ChangesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const direction: Direction = parseDirection(first(params.dir));
  const requested = Number(first(params.n));
  const limit = Number.isSafeInteger(requested)
    ? Math.min(Math.max(requested, CHANGES_PAGE_SIZE), MAX_RESULTS)
    : CHANGES_PAGE_SIZE;

  const [scoped, counts, basket] = await Promise.all([
    loadScopedStores(),
    getPriceChangeCountsCached(),
    readBasket(),
  ]);
  const inScope = scoped.storeIds ?? scoped.stores.map((s) => s.id);
  const store = parseStoreFilter(first(params.store), inScope);
  const day = counts.data ? latestChangeDay(counts.data) : null;
  const totals = tally(counts.data ?? [], day, scoped.storeIds);
  const ids = store !== null ? [store] : scoped.storeIds;
  const other: Direction = direction === "down" ? "up" : "down";

  // Packaged items make the list and the headline cards; items sold by weight
  // get their own short list below it (isWeighed in lib/changes.ts says why).
  const [list, otherTop, weighedList] = day
    ? await Promise.all([
        getPriceChangesCached({ day, direction, storeIds: ids, limit, weighed: false }),
        getPriceChangesCached({ day, direction: other, storeIds: ids, limit: 1, weighed: false }),
        getPriceChangesCached({ day, direction, storeIds: ids, limit: WEIGHED_SHOWN, weighed: true }),
      ])
    : [null, null, null];
  const rows = list?.data?.rows ?? [];
  const hasMore = (list?.data?.hasMore ?? false) && limit < MAX_RESULTS;
  const weighedRows = weighedList?.data?.rows ?? [];
  const weighedMore = weighedList?.data?.hasMore ?? false;
  const error = scoped.error ?? counts.error ?? list?.error ?? otherTop?.error ?? weighedList?.error ?? null;

  const top = { [direction]: rows[0], [other]: otherTop?.data?.rows[0] } as Record<Direction, PriceChange | undefined>;
  const filtered = store !== null ? totals.byStore.get(store) ?? { drops: 0, rises: 0 } : totals;
  const shown = direction === "down" ? filtered.drops : filtered.rises;
  const storesWithChanges = scoped.stores.filter((s) => totals.byStore.has(s.id));
  const storeLabel = (id: number) => {
    const s = scoped.stores.find((x) => x.id === id);
    return s ? storeName(s.banner_slug, s.retailer_name, s.label) : "this store";
  };
  const scopeHelp = storeScopeHelp(scoped, "results");
  const word = direction === "down" ? "drops" : "increases";

  return (
    <main>
      <a className="skip-link" href="#changes">Skip to price changes</a>
      <div className="site-shell" id="top">
        <div className="hero-wrap hero-wrap-compact">
          <SiteHeader current="changes" />
          <div className="compact-search">
            <SearchForm compact />
          </div>
        </div>

        <article className="changes-page">
          <div className="section-heading">
            <div>
              <p className="section-label">Price changes{day ? ` · ${dayHeading(day)}` : ""}</p>
              <h1>What changed overnight</h1>
              <p>
                Every shelf price that moved since each store’s previous night, biggest change first.
                Stores are checked every night.
              </p>
            </div>
          </div>

          {error && (
            <div role="alert" className="data-alert">Price data is unavailable right now. Please try again soon.</div>
          )}

          {!error && !day && (
            <div className="empty-state">
              <p>No price changes recorded yet.</p>
              <p>Changes appear after a store has been checked two nights in a row.</p>
            </div>
          )}

          {!error && day && (
            <>
              <div className="changes-summary">
                <article className="changes-card changes-card-down">
                  <p className="changes-card-label">Went down</p>
                  <p className="changes-card-count">{count(filtered.drops)} {filtered.drops === 1 ? "price" : "prices"}</p>
                  <p>{biggest(top.down) ?? "Nothing went down."}</p>
                </article>
                <article className="changes-card changes-card-up">
                  <p className="changes-card-label">Went up</p>
                  <p className="changes-card-count">{count(filtered.rises)} {filtered.rises === 1 ? "price" : "prices"}</p>
                  <p>{biggest(top.up) ?? "Nothing went up."}</p>
                </article>
                {isFlyerNight(day) ? (
                  <article className="changes-card changes-card-flyer">
                    <p className="changes-card-label">Thursday</p>
                    <p className="changes-card-count">New flyer week</p>
                    <p>Most weekly flyers start today, so this is the busiest night of the week for price changes.</p>
                  </article>
                ) : (
                  <article className="changes-card changes-card-note">
                    <p className="changes-card-label">When prices move</p>
                    <p className="changes-card-count">Thursdays</p>
                    <p>Most weekly flyers start on Thursday, so that night brings far more changes than the rest.</p>
                  </article>
                )}
              </div>

              <div className="results-toolbar" id="changes">
                <nav className="sort-toggle" aria-label="Direction">
                  {(["down", "up"] as const).map((d) => (
                    <Link
                      key={d}
                      href={changesHref({ direction: d, store })}
                      aria-current={d === direction ? "true" : undefined}
                      scroll={false}
                    >
                      {d === "down" ? "Price drops" : "Price increases"}
                      <span className="toggle-count">{count(d === "down" ? filtered.drops : filtered.rises)}</span>
                    </Link>
                  ))}
                </nav>
                <StoreScopeControl scoped={scoped} />
              </div>
              {scopeHelp && <p className="scope-help">{scopeHelp}</p>}

              {storesWithChanges.length > 1 && (
                <>
                  <nav className="store-filter" aria-label="Store">
                    <span className="store-filter-label">Store</span>
                    <Link
                      href={changesHref({ direction, store: null })}
                      aria-current={store === null ? "true" : undefined}
                      className="store-filter-all"
                      scroll={false}
                    >
                      All stores · {count(direction === "down" ? totals.drops : totals.rises)}
                    </Link>
                    {storesWithChanges.map((s) => {
                      const c = totals.byStore.get(s.id)!;
                      return (
                        <Link
                          key={s.id}
                          href={changesHref({ direction, store: s.id })}
                          aria-current={store === s.id ? "true" : undefined}
                          className="store-chip"
                          scroll={false}
                        >
                          <StoreDot slug={s.banner_slug} mark={scoped.marks.get(s.id)} as="i" className="" />
                          {BANNER_SHORT[s.banner_slug] ?? s.retailer_name}
                          <span className="store-chip-area">
                            {storeArea(s.label) ?? ""} · {count(direction === "down" ? c.drops : c.rises)}
                          </span>
                        </Link>
                      );
                    })}
                  </nav>
                  <details className="store-filter-menu">
                    <summary>Store: {store === null ? "All stores" : storeLabel(store)} ({count(shown)})</summary>
                    <ul>
                      <li>
                        <Link href={changesHref({ direction, store: null })} aria-current={store === null ? "true" : undefined}>
                          All stores · {count(direction === "down" ? totals.drops : totals.rises)}
                        </Link>
                      </li>
                      {storesWithChanges.map((s) => {
                        const c = totals.byStore.get(s.id)!;
                        return (
                          <li key={s.id}>
                            <Link href={changesHref({ direction, store: s.id })} aria-current={store === s.id ? "true" : undefined}>
                              <StoreDot slug={s.banner_slug} mark={scoped.marks.get(s.id)} />
                              {storeLabel(s.id)} · {count(direction === "down" ? c.drops : c.rises)}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                </>
              )}

              {rows.length > 0 && (
                <ul className="change-list">
                  {rows.map((change, index) => (
                    <ChangeRow
                      key={change.product_id}
                      id={`change-${index}`}
                      change={change}
                      quantity={basket.get(change.product_id) ?? 0}
                      mark={scoped.marks.get(change.store_id)}
                    />
                  ))}
                </ul>
              )}
              {rows.length === 0 && weighedRows.length === 0 && (
                <div className="empty-state">
                  <p>No price {word} {store !== null ? `at ${storeLabel(store)} ` : ""}overnight.</p>
                  <p>
                    {direction === "down" ? (
                      <Link href={changesHref({ direction: "up", store })}>See the increases</Link>
                    ) : (
                      <Link href={changesHref({ direction: "down", store })}>See the drops</Link>
                    )}{" "}
                    or <Link href="/">search a staple</Link>.
                  </p>
                </div>
              )}

              {hasMore && (
                <Link
                  className="show-more"
                  href={`${changesHref({ direction, store, count: limit + CHANGES_PAGE_SIZE })}#change-${limit}`}
                  scroll={false}
                >
                  Show more price {word} <ArrowDown size={18} aria-hidden="true" />
                </Link>
              )}

              {weighedRows.length > 0 && (
                <section className="weighed-changes" aria-labelledby="weighed-heading">
                  <h2 id="weighed-heading">Sold by weight</h2>
                  <p>
                    Loose produce and deli items are priced per piece at a weight the store estimates, so a change
                    here can be that estimate moving as well as the price. They are listed apart from packaged
                    groceries{weighedMore ? `; the ${WEIGHED_SHOWN} biggest are shown` : ""}.
                  </p>
                  <ul className="change-list">
                    {weighedRows.map((change) => (
                      <ChangeRow
                        key={change.product_id}
                        change={change}
                        quantity={basket.get(change.product_id) ?? 0}
                        mark={scoped.marks.get(change.store_id)}
                      />
                    ))}
                  </ul>
                </section>
              )}

              <p className="price-note">
                A change compares tonight’s shelf price with the price the store had the night before. Items that
                disappeared and came back are left out, and so are out-of-stock listings.{" "}
                <Link href="/how-it-works">How prices are checked <ArrowRight size={13} aria-hidden="true" /></Link>
              </p>
            </>
          )}
        </article>

        <SiteFooter />
      </div>
    </main>
  );
}
