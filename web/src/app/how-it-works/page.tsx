import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { unstable_cache } from "next/cache";
import { ArrowRight, CalendarDays, CircleCheck, MapPin, Search, Store } from "lucide-react";

import { StoreChip } from "@/components/price-row";
import { SearchForm } from "@/components/search-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Sparkline } from "@/components/sparkline";
import { RangeBar, verdictText } from "@/components/verdict";
import { AISLES, SEARCH_TERM_COUNT } from "@/lib/aisles";
import {
  daysAtPrice,
  dayNumber,
  isoDay,
  pickExample,
  priceLog,
  summarize,
  type LogEntry,
  type Span,
  type Verdict,
} from "@/lib/history";
import {
  getChangeCount,
  getCoverage,
  getLatestRuns,
  getPriceHistory,
  getRecentHistory,
  getStores,
  searchProducts,
  type IngestRun,
  type LatestPrice,
  type StoreInfo,
} from "@/lib/queries";
import { BANNER_COLORS, BANNER_SHORT, storeArea } from "@/lib/stores";
import { formatCents, formatDay } from "@/lib/utils";

export const metadata: Metadata = {
  title: "How it works | Loonie",
  description:
    "How Loonie checks grocery prices every night, keeps their history, and decides whether today's price is a good one.",
};

/** The status and the example change once a day, so a few minutes' cache spares the database. */
const CACHE_SECONDS = 900;

/** Items the worked example can use. Each is a site search that finds real listings. */
const EXAMPLES = [
  { key: "eggs", label: "Large eggs", term: "large eggs" },
  { key: "chicken", label: "Chicken breast", term: "chicken breast" },
  { key: "yogurt", label: "Greek yogurt", term: "greek yogurt" },
  { key: "coffee", label: "Ground coffee", term: "ground coffee" },
  { key: "juice", label: "Orange juice", term: "orange juice" },
];

/** Listings the example picker considers, cheapest first. */
const EXAMPLE_CANDIDATES = 200;

type StoreStatus = StoreInfo & { run: IngestRun | null; changed: number | null; behind: boolean };

type NightlyStatus = {
  stores: StoreStatus[];
  /** When the most recent store finished, as an ISO timestamp. */
  lastCheckedAt: string | null;
  prices: number;
  changed: number | null;
  firstDay: string | null;
  days: number;
  /** True when no store has been checked for more than a day and a half. */
  stale: boolean;
};

/**
 * Every store with its latest run and how many rows that run wrote. Throws
 * rather than returning an error so a failure is never cached.
 */
const loadStatus = unstable_cache(
  async (): Promise<NightlyStatus> => {
    const [stores, runs, coverage] = await Promise.all([getStores(), getLatestRuns(), getCoverage()]);
    if (stores.error !== null) throw new Error(stores.error);
    if (runs.error !== null) throw new Error(runs.error);
    const runFor = new Map(runs.data.map((run) => [run.store_id, run]));
    const counts = await Promise.all(
      stores.data.map((store) => {
        const run = runFor.get(store.id);
        return run ? getChangeCount(store.id, run.run_on) : Promise.resolve(null);
      }),
    );
    const newest = runs.data.reduce<string | null>((max, r) => (max === null || r.run_on > max ? r.run_on : max), null);
    const statuses = stores.data.map((store, i) => {
      const run = runFor.get(store.id) ?? null;
      return {
        ...store,
        run,
        changed: counts[i]?.data ?? null,
        behind: run === null || (newest !== null && run.run_on < newest),
      };
    });
    const withRuns = statuses.filter((s) => s.run !== null);
    const lastCheckedAt = withRuns.reduce<string | null>(
      (max, s) => (max === null || s.run!.recorded_at > max ? s.run!.recorded_at : max),
      null,
    );
    const counted = withRuns.every((s) => s.changed !== null);
    return {
      stores: statuses,
      lastCheckedAt,
      prices: withRuns.reduce((sum, s) => sum + s.run!.products_observed, 0),
      changed: counted ? withRuns.reduce((sum, s) => sum + (s.changed ?? 0), 0) : null,
      firstDay: coverage.data?.first_day ?? null,
      days: coverage.data?.days ?? 0,
      stale: lastCheckedAt === null || Date.now() - Date.parse(lastCheckedAt) > 36 * 3_600_000,
    };
  },
  ["how-it-works-status"],
  { revalidate: CACHE_SECONDS },
);

type WorkedExample = { row: LatestPrice; spans: Span[] };

/**
 * A listing for the worked example: of the cheapest matches, the one whose
 * price moved most in the last 30 days, with its full history so the verdict
 * is worked out exactly as its product page works it out.
 */
const loadExample = unstable_cache(
  async (term: string): Promise<WorkedExample | null> => {
    const found = await searchProducts(term, { limit: EXAMPLE_CANDIDATES });
    if (found.error !== null) throw new Error(found.error);
    const rows = found.data.rows;
    if (rows.length === 0) return null;
    const latest = Math.max(...rows.map((r) => dayNumber(r.observed_on)));
    const recent = await getRecentHistory(
      rows.map((r) => r.product_id),
      isoDay(latest - 29),
    );
    if (recent.error !== null) throw new Error(recent.error);
    const id = pickExample(
      rows.map((r) => ({
        id: r.product_id,
        price: r.price_cents,
        inStock: r.in_stock,
        spans: recent.data.filter((s) => s.product_id === r.product_id),
      })),
    );
    const row = rows.find((r) => r.product_id === id);
    if (!row) return null;
    const history = await getPriceHistory([row.product_id]);
    if (history.error !== null) throw new Error(history.error);
    return { row, spans: history.data };
  },
  ["how-it-works-example"],
  { revalidate: CACHE_SECONDS },
);

async function attempt<T>(load: () => Promise<T>): Promise<{ data: T; failed: false } | { data: null; failed: true }> {
  try {
    return { data: await load(), failed: false };
  } catch {
    return { data: null, failed: true };
  }
}

const numberWords = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const inWords = (n: number) => numberWords[n] ?? n.toLocaleString("en-CA");
const count = (n: number) => n.toLocaleString("en-CA");

/** "Sep 27, 9:16 a.m. ET": when a run finished, in the stores' own time zone. */
function checkedAt(iso: string, withDay = true): string {
  const time = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    ...(withDay ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
  return `${time} ET`;
}

function dayRange(from: string, to: string): string {
  return from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function LiveStatus({ status }: { status: NightlyStatus | null }) {
  if (!status || !status.lastCheckedAt) {
    return <p className="live-status">Prices are checked once a day, every day.</p>;
  }
  return (
    <p className={status.stale ? "live-status live-status-stale" : "live-status"}>
      <i aria-hidden="true" />
      {status.stale ? "Behind schedule: last checked " : "Last checked "}
      {checkedAt(status.lastCheckedAt)}
      <span aria-hidden="true">·</span>
      {count(status.prices)} prices
      {status.changed !== null && (
        <>
          <span aria-hidden="true">·</span>
          {count(status.changed)} changed
        </>
      )}
    </p>
  );
}

const jumpLinks = [
  { href: "#steps", label: "The nightly check" },
  { href: "#reading", label: "Reading a price" },
  { href: "#example", label: "Try real prices" },
  { href: "#stores", label: "The stores" },
  { href: "#faq", label: "Questions" },
];

function Steps({ status }: { status: NightlyStatus | null }) {
  const storeCount = status?.stores.length ?? 0;
  const percent = status && status.changed !== null && status.prices > 0 ? (status.changed / status.prices) * 100 : 0;
  // A share that rounds to 0.0% says nothing, so it is left off.
  const share = percent >= 0.05 ? ` (${percent.toFixed(1)}%)` : "";
  const steps = [
    {
      tone: "yellow",
      art: "six-stores.png",
      title: `We check ${storeCount > 0 ? inWords(storeCount) : "the"} stores`,
      body: `Overnight, Loonie searches ${SEARCH_TERM_COUNT} everyday items at one store from each chain, and records every price, sale and unit price it finds.`,
      fact: status && status.prices > 0 ? `Last night: ${count(status.prices)} prices` : "Checked once a day",
    },
    {
      tone: "lilac",
      art: "only-changes.png",
      title: "We keep only what changed",
      body: "If a price matches yesterday’s, Loonie just notes it’s still true. A new row is saved only when the price, sale or stock changes.",
      fact:
        status && status.changed !== null
          ? `Last night: ${count(status.changed)} change${status.changed === 1 ? "" : "s"}${share}`
          : "Only changes are saved",
    },
    {
      tone: "pink",
      art: "compare.png",
      title: "We compare with its history",
      body: "Each listing is measured against its own past at that store: its lowest and highest price, and its typical price, the one it sat at most days.",
      fact: status?.firstDay
        ? `History since ${formatDay(status.firstDay)} · ${status.days} day${status.days === 1 ? "" : "s"}`
        : "History grows every night",
    },
    {
      tone: "blue",
      art: "basket.png",
      title: "You shop smarter",
      body: "Search for today’s prices cheapest first, open any item for its graph, and price your whole list in the basket.",
      link: { href: "/basket", label: "Open your basket" },
    },
  ];
  return (
    <ol className="hiw-steps">
      {steps.map((step, i) => (
        <li key={step.title} className={`hiw-step hiw-step-${step.tone}`}>
          <Image src={`/illustrations/how-it-works/${step.art}`} alt="" width={320} height={200} />
          <span className="hiw-step-num" aria-hidden="true">{i + 1}</span>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
          {step.link ? (
            <Link href={step.link.href} className="hiw-fact">
              {step.link.label} <ArrowRight size={15} aria-hidden="true" />
            </Link>
          ) : (
            <p className="hiw-fact">
              <i aria-hidden="true" />
              {step.fact}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A search result drawn for the key, numbered to match it. Decorative, so hidden from screen readers. */
function Specimen() {
  const n = (k: number) => (
    <span className="callout" aria-hidden="true">
      {k}
    </span>
  );
  return (
    <div className="specimen" aria-hidden="true">
      <div className="specimen-product">
        <strong>Grade A Large Eggs</strong>
        <span>Burnbrae Farms · 18 ea</span>
        <div className="price-row-chips">
          <span className="store-chip">
            {n(1)}
            <i style={{ background: BANNER_COLORS.loblaw }} />
            Loblaws
            <span className="store-chip-area">Markham Bullock Drive</span>
          </span>
          <span className="status-badge status-good">Lowest in 30 days{n(2)}</span>
        </div>
      </div>
      <div className="specimen-trend">
        {n(3)}
        <Sparkline values={[698, 698, 444, 444, 444, 444, 444]} color={BANNER_COLORS.loblaw} />
        <small>Last 7 days</small>
      </div>
      <div className="specimen-amount">
        <strong>$4.44</strong>
        <span className="deal-tag deal-sale">Store sale · was $6.98{n(4)}</span>
        <span className="specimen-unit">$0.25 each{n(5)}</span>
      </div>
      <span className="basket-button basket-button-small specimen-add">+ Add</span>
    </div>
  );
}

function Legend() {
  const items = [
    {
      title: "Where it was recorded",
      body: "Every price names its store and place. Prices can differ between locations.",
      ui: (
        <span className="store-chip">
          <i style={{ background: BANNER_COLORS.nofrills }} aria-hidden="true" />
          No Frills
          <span className="store-chip-area">Vaughan</span>
        </span>
      ),
    },
    {
      title: "How today compares",
      body: "Against that listing’s last 30 days at the same store.",
      ui: (
        <>
          <span className="status-badge status-good">Lowest in 30 days</span>
          <span className="status-badge status-good">Below typical</span>
          <span className="status-badge status-neutral">Steady price</span>
          <span className="status-badge status-bad">Above typical</span>
        </>
      ),
    },
    {
      title: "The last 7 days",
      body: "One point per day. A gap means it wasn’t listed that day.",
      ui: <Sparkline values={[529, 529, null, 499, 499, 449, 449]} color={BANNER_COLORS.superstore} width={150} />,
    },
    {
      title: "Sales and deals",
      body: "A sale is marked by the store. “Usually” is Loonie’s estimate for a deal the store didn’t label, from its own unit price.",
      ui: (
        <>
          <span className="deal-tag deal-sale">Store sale · was $6.98</span>
          <span className="deal-tag deal-usual">Usually ~$4.28* · 32% off</span>
        </>
      ),
    },
    {
      title: "Unit price",
      body: "Compares different sizes fairly. Sort results by best value to rank by it.",
      ui: (
        <>
          <strong className="legend-unit">$0.93/100g</strong>
          <Link href="/?q=yogurt&sort=value#prices" className="legend-sort">
            Best value per 100 g / ml
          </Link>
        </>
      ),
    },
    {
      title: "Same item or similar",
      body: "Same item: a shared product code, or the same brand, name and size. Similar items are shown, never totalled.",
      ui: (
        <>
          <small className="legend-code">Another product code</small>
          <span className="similar-hint-label">Similar for less</span>
        </>
      ),
    },
  ];
  return (
    <ol className="legend">
      {items.map((item, i) => (
        <li key={item.title}>
          <h3>
            <span className="callout" aria-hidden="true">{i + 1}</span>
            {item.title}
          </h3>
          <div className="legend-ui">{item.ui}</div>
          <p>{item.body}</p>
        </li>
      ))}
    </ol>
  );
}

const noteLabel: Record<NonNullable<LogEntry["note"]>, (e: LogEntry) => string> = {
  sale: (e) => `Store sale · was ${formatCents(e.regular)}`,
  usual: (e) => `Usually ~${formatCents(e.regular)}*`,
  out: () => "Out of stock",
};

/** Why the verdict came out the way it did, one short step at a time. */
function reasons(verdict: Verdict, spans: Span[], price: number): string[] {
  const seen = spans.reduce(
    (sum, s) => sum + dayNumber(s.last_confirmed_on) - dayNumber(s.first_observed_on) + 1,
    0,
  );
  const typicalDays = daysAtPrice(spans, verdict.typical);
  const since = formatDay(verdict.since);
  const steps = [`Tracked for ${verdict.daysTracked} day${verdict.daysTracked === 1 ? "" : "s"}, since ${since}.`];
  if (verdict.kind === "new") {
    steps.push("That’s its first day, so there’s nothing to compare it with yet.");
    return steps;
  }
  steps.push(
    verdict.lowest === verdict.highest
      ? `It has been ${formatCents(verdict.lowest)} every day it was seen.`
      : `It ranged from ${formatCents(verdict.lowest)} to ${formatCents(verdict.highest)}.`,
  );
  steps.push(
    `Typical is ${formatCents(verdict.typical)}: the price on ${typicalDays} of the ${seen} day${seen === 1 ? "" : "s"} it was seen.`,
  );
  const latest = formatCents(price);
  steps.push(
    {
      steady: `Latest is ${latest}, the same as always.`,
      lowest: `Latest is ${latest}, the lowest recorded.`,
      below: `Latest is ${latest}, below its typical price.`,
      above: `Latest is ${latest}, above its typical price. It has been cheaper.`,
      typical: `Latest is ${latest}, so it’s at its typical price.`,
    }[verdict.kind],
  );
  return steps;
}

/** How many log lines to show; older ones are summarised in a note. */
const LOG_LINES = 6;

function Worked({ example, failed, label }: { example: WorkedExample | null; failed: boolean; label: string }) {
  if (failed) {
    return <div role="alert" className="data-alert">Price data is unavailable right now. Please try again soon.</div>;
  }
  if (!example) {
    return <p className="empty-state">No listings found for {label.toLowerCase()} yet.</p>;
  }
  const { row, spans } = example;
  const verdict = summarize(spans, row.price_cents);
  const log = priceLog(spans);
  const shown = log.slice(-LOG_LINES);
  const prices = [...new Set(spans.map((s) => s.price_cents))]
    .map((price) => ({ price, days: daysAtPrice(spans, price) }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 3);
  const productHref = `/product/${row.product_id}`;

  return (
    <article className="worked" aria-labelledby="worked-title">
      <div className="worked-listing">
        <StoreChip row={row} />
        <h3 id="worked-title">
          <Link href={productHref}>{row.raw_name}</Link>
        </h3>
        <p className="worked-meta">{[row.brand, row.package_size].filter(Boolean).join(" · ") || "Grocery item"}</p>
        <p className="worked-price">
          <strong>{formatCents(row.price_cents)}</strong> latest price
        </p>
        <table className="price-log">
          <caption>Price log</caption>
          <thead>
            <tr>
              <th scope="col">Days</th>
              <th scope="col">Price</th>
              <th scope="col">Label</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.from}>
                <td>{dayRange(entry.from, entry.to)}</td>
                <td>{formatCents(entry.price)}</td>
                <td>
                  {entry.note ? (
                    <span className={`deal-tag ${entry.note === "usual" ? "deal-usual" : "deal-sale"}`}>
                      {noteLabel[entry.note](entry)}
                    </span>
                  ) : (
                    <span className="log-regular">Regular price</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="price-note">
          {prices.map((p) => `${p.days} day${p.days === 1 ? "" : "s"} at ${formatCents(p.price)}`).join(" · ")}
          {log.length > shown.length && ` · ${log.length - shown.length} earlier change${log.length - shown.length === 1 ? "" : "s"} on its graph`}
        </p>
      </div>
      <div className="worked-reasoning">
        <p className="section-label">How the verdict is worked out</p>
        {verdict ? (
          <>
            <ol className="reason-list">
              {reasons(verdict, spans, row.price_cents).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
            <div className={`worked-verdict verdict-${verdict.kind}`}>
              <h4>{verdictText(verdict).headline}</h4>
              {verdict.lowest < verdict.highest && <RangeBar verdict={verdict} price={row.price_cents} />}
              <Link href={productHref}>
                Open its price graph <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </>
        ) : (
          <p>No history recorded for this listing yet.</p>
        )}
      </div>
    </article>
  );
}

function StoreBoard({ status }: { status: NightlyStatus }) {
  return (
    <ul className="store-board">
      {status.stores.map((store) => {
        const place = storeArea(store.label);
        const name = BANNER_SHORT[store.banner_slug] ?? store.retailer_name;
        const color = BANNER_COLORS[store.banner_slug] ?? "#53617e";
        const mapQuery = [store.label, store.postal_code].filter(Boolean).join(" ");
        return (
          <li key={store.id} className="store-card" style={{ borderLeftColor: color }}>
            <div className="store-card-head">
              <span className="store-dot" style={{ background: color }} aria-hidden="true" />
              <h3>{name}</h3>
              {store.postal_code && <span className="store-card-postal">{store.postal_code}</span>}
            </div>
            <p className="store-card-place">
              {place ?? "Location not recorded"}
              {mapQuery && (
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <MapPin size={13} aria-hidden="true" /> Map<span className="visually-hidden"> of {name}, opens in a new tab</span>
                </a>
              )}
            </p>
            <div className="store-card-stats">
              {store.run ? (
                <span className={store.behind ? "run-badge run-behind" : "run-badge"}>
                  <i aria-hidden="true" />
                  {store.behind ? "Behind: " : "Checked "}
                  {formatDay(store.run.run_on)} · {checkedAt(store.run.recorded_at, false)}
                </span>
              ) : (
                <span className="run-badge run-behind">
                  <i aria-hidden="true" />
                  Not checked this week
                </span>
              )}
              {store.run && <span className="stat-prices">{count(store.run.products_observed)} prices</span>}
              {store.changed !== null && <span className="stat-changed">{count(store.changed)} changed</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Faq({ status }: { status: NightlyStatus | null }) {
  const places = (status?.stores ?? [])
    .map((s) => ({ name: BANNER_SHORT[s.banner_slug] ?? s.retailer_name, place: storeArea(s.label) }))
    .filter((s) => s.place);
  const questions = [
    {
      q: "How often are prices updated?",
      a: (
        <>
          Once a day. The check is scheduled overnight and usually finishes by mid-morning Eastern time.
          {status?.lastCheckedAt && <> The last one finished {checkedAt(status.lastCheckedAt)}.</>}
        </>
      ),
    },
    {
      q: "Why are the stores in different cities?",
      a: (
        <>
          Loonie checks {status?.stores.length ? `${inWords(status.stores.length)} stores` : "a handful of stores"}
          {places.length > 0 && <>: {places.map((p) => `${p.name} in ${p.place}`).join(", ")}</>}. Prices,
          and even brands, vary by region, which is why every price shows where it was recorded. Search,
          product pages and the basket show the Ontario stores unless you choose to show all of them.
        </>
      ),
    },
    {
      q: "What does “typical price” mean?",
      a: "The price an item sat at on the most days Loonie has seen it at that store. A one-day sale doesn’t move it; a price that holds for weeks does.",
    },
    {
      q: "How does Loonie know two listings are the same item?",
      a: "Most national brands share a product code across these chains, and a shared code is the same item. When codes differ, Loonie only matches listings with the same brand, name and package size. Items that are merely alike are shown as similar, and never counted in basket totals.",
    },
    {
      q: "Is Loonie free? What happens to my basket?",
      a: "Yes, it’s free: an independent, non-commercial project with no accounts and no ads. Your basket is kept in a cookie in your own browser.",
    },
    {
      q: "Why can’t I find an item?",
      a: (
        <>
          Loonie only records what its {SEARCH_TERM_COUNT} everyday searches turn up, so less common items can be
          missing. Try a simpler word, like <Link href="/?q=yogurt#prices">yogurt</Link> instead of a brand name.
        </>
      ),
    },
  ];
  return (
    <div className="faq-list">
      {questions.map((item, i) => (
        <details key={item.q} open={i === 0}>
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
    </div>
  );
}

export default async function HowItWorksPage({
  searchParams,
}: {
  searchParams: Promise<{ example?: string | string[] }>;
}) {
  const chosen = first((await searchParams).example);
  const example = EXAMPLES.find((e) => e.key === chosen) ?? EXAMPLES[0];
  const [status, worked] = await Promise.all([
    attempt(() => loadStatus()),
    attempt(() => loadExample(example.term)),
  ]);
  const nightly = status.data;
  const storeCount = nightly?.stores.length ?? 0;

  return (
    <main>
      <a className="skip-link" href="#steps">Skip to how it works</a>
      <div className="site-shell" id="top">
        <div className="hero-wrap">
          <SiteHeader current="how-it-works" />
          <section className="hiw-hero" aria-labelledby="hiw-title">
            <div className="hiw-hero-copy">
              <p className="hiw-eyebrow">How it works <span aria-hidden="true">✦</span></p>
              <h1 id="hiw-title">
                We check the shelves every night<span className="gold-stop">.</span>
              </h1>
              <p className="hiw-lede">
                Loonie records grocery prices at {storeCount > 0 ? inWords(storeCount) : "several"} Canadian stores
                every night, keeps the whole history, and tells you whether today’s price is actually a good one.
              </p>
              <LiveStatus status={nightly} />
              <nav className="hiw-jump" aria-label="On this page">
                <span>Jump to</span>
                {jumpLinks.map((link) => (
                  <a key={link.href} href={link.href}>{link.label}</a>
                ))}
              </nav>
            </div>
            <Image
              className="hiw-hero-art"
              src="/illustrations/how-it-works/nightly-check.png"
              alt=""
              width={480}
              height={452}
              priority
            />
          </section>
        </div>

        <section className="hiw-section" id="steps" aria-labelledby="steps-title">
          <div className="section-heading">
            <div>
              <p className="section-label">The nightly check</p>
              <h2 id="steps-title">Four steps, every night.</h2>
              <p>No guesses and no ads: just what each store’s website charged, recorded day after day.</p>
            </div>
          </div>
          <Steps status={nightly} />
        </section>

        <section className="hiw-section" id="reading" aria-labelledby="reading-title">
          <div className="section-heading">
            <div>
              <p className="section-label">Reading a price</p>
              <h2 id="reading-title">What every label means.</h2>
              <p>The same labels you’ll see in search results and on product pages.</p>
            </div>
          </div>
          <Specimen />
          <Legend />
        </section>

        <section className="hiw-section hiw-band" id="example" aria-labelledby="example-title">
          <div className="section-heading">
            <div>
              <p className="section-label">Try it on real prices</p>
              <h2 id="example-title">Watch a verdict get worked out.</h2>
              <p>Pick an item. Loonie finds a listing whose price moved recently and shows its working.</p>
            </div>
          </div>
          <nav className="example-picker" aria-label="Pick an item">
            {EXAMPLES.map((e) => (
              <Link
                key={e.key}
                href={`/how-it-works?example=${e.key}#example`}
                aria-current={e.key === example.key ? "true" : undefined}
                scroll={false}
              >
                {e.label}
              </Link>
            ))}
          </nav>
          <Worked example={worked.data} failed={worked.failed} label={example.label} />
        </section>

        <section className="hiw-section" id="stores" aria-labelledby="stores-title">
          <div className="section-heading">
            <div>
              <p className="section-label">Where the prices come from</p>
              <h2 id="stores-title">
                {storeCount > 0 ? `${inWords(storeCount)[0].toUpperCase()}${inWords(storeCount).slice(1)} stores` : "The stores"}, one from each chain.
              </h2>
              <p>Online prices for pickup at these stores. Your own store may charge a little differently.</p>
            </div>
          </div>
          {nightly ? (
            <StoreBoard status={nightly} />
          ) : (
            <div role="alert" className="data-alert">Store details are unavailable right now. Please try again soon.</div>
          )}
          <div className="aisles">
            <p>
              <Search size={16} aria-hidden="true" />
              <span>
                <strong>{SEARCH_TERM_COUNT} everyday searches</strong> across {AISLES.length} aisles. Try one:
              </span>
            </p>
            <ul>
              {AISLES.map((aisle) => (
                <li key={aisle.key}>
                  <Link href={`/?q=${encodeURIComponent(aisle.sample)}#prices`} title={`Search “${aisle.sample}”`}>
                    {aisle.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="hiw-section hiw-faq" id="faq" aria-labelledby="faq-title">
          <aside className="good-to-know" aria-labelledby="limits-title">
            <p className="section-label">Good to know</p>
            <h2 id="limits-title">What Loonie can’t do (yet)</h2>
            <ul>
              <li>
                <Store size={18} aria-hidden="true" />
                <div>
                  <strong>Online prices, from a handful of stores</strong>
                  <span>In-store prices, and other locations of the same chain, can differ.</span>
                </div>
              </li>
              <li>
                <Search size={18} aria-hidden="true" />
                <div>
                  <strong>Everyday items, not everything</strong>
                  <span>
                    It searches {SEARCH_TERM_COUNT} common items across {AISLES.length} aisles
                    {nightly && nightly.prices > 0 ? `, about ${count(Math.round(nightly.prices / 1000) * 1000)} listings a night` : ""}.
                  </span>
                </div>
              </li>
              <li>
                <CalendarDays size={18} aria-hidden="true" />
                <div>
                  <strong>
                    {nightly?.firstDay ? `History started ${formatDay(nightly.firstDay)}, ${nightly.firstDay.slice(0, 4)}` : "History is still short"}
                  </strong>
                  <span>Verdicts get more reliable every night.</span>
                </div>
              </li>
              <li>
                <CircleCheck size={18} aria-hidden="true" />
                <div>
                  <strong>Snapshots, not quotes</strong>
                  <span>Prices can change during the day. Always check at the till.</span>
                </div>
              </li>
            </ul>
          </aside>
          <div>
            <p className="section-label">Questions</p>
            <h2 id="faq-title" className="faq-title">Questions people ask.</h2>
            <Faq status={nightly} />
          </div>
        </section>

        <section className="hiw-cta" aria-labelledby="cta-title">
          <div className="hiw-cta-copy">
            <h2 id="cta-title">Ready to check a price?</h2>
            <p>Search any staple and see if today’s a good day to buy.</p>
          </div>
          <SearchForm />
          <div className="staples">
            <span>Try</span>
            {["milk", "eggs", "bananas"].map((term) => (
              <Link key={term} href={`/?q=${term}#prices`}>
                {term[0].toUpperCase() + term.slice(1)}
              </Link>
            ))}
          </div>
        </section>

        <SiteFooter />
      </div>
    </main>
  );
}
