import { getCoverage, searchProducts, type LatestPrice } from "@/lib/queries";
import { formatCents, formatDay, formatUnitPrice } from "@/lib/utils";

const BANNER_LABELS: Record<string, string> = {
  nofrills: "No Frills",
  superstore: "Superstore",
  loblaw: "Loblaws",
};

/** A deal's regular price, when the store did not declare one. */
function usualPrice(row: LatestPrice): number | null {
  return row.was_price_cents === null ? (row.implied_regular_cents ?? null) : null;
}

function PriceRow({ row }: { row: LatestPrice }) {
  const usual = usualPrice(row);
  const unitPrice = formatUnitPrice(
    row.unit_price_cents,
    row.comparison_quantity,
    row.comparison_unit,
  );

  return (
    <li className="flex items-start justify-between gap-4 border-b border-neutral-200 py-3 last:border-0 dark:border-neutral-800">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.raw_name}</p>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {[row.brand, row.package_size].filter(Boolean).join(" · ") || "—"}
        </p>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">
            {BANNER_LABELS[row.banner_slug] ?? row.retailer_name}
          </span>
          {" · "}
          {formatDay(row.observed_on)}
          {!row.in_stock && " · out of stock"}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums">
          {formatCents(row.price_cents)}
        </p>
        {row.was_price_cents !== null && (
          <p className="text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
            was{" "}
            <span className="line-through text-neutral-400 dark:text-neutral-500">
              {formatCents(row.was_price_cents)}
            </span>
          </p>
        )}
        {usual !== null && (
          <p
            className="text-xs tabular-nums text-emerald-600 dark:text-emerald-400"
            title="Estimated from the store's own unit price. The store does not mark this as a sale."
          >
            usually ~{formatCents(usual)}
          </p>
        )}
        {unitPrice && (
          <p className="mt-0.5 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
            {unitPrice}
          </p>
        )}
      </div>
    </li>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const [results, coverage] = await Promise.all([
    searchProducts(q),
    getCoverage(),
  ]);

  const failure = results.error ?? coverage.error;

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Canadian grocery price history
        </h1>
        <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          Flyer apps tell you what is on sale this week. None of them tell you
          whether $4.99 is actually a good price or just the usual price with a
          sale sticker on it. This tracks store-level prices daily so that
          question has an answer.
        </p>
      </header>

      {/* A plain GET form: it works before JavaScript loads, the results are
          server rendered, and every search is a shareable URL. */}
      <form action="/" method="get" className="mt-8 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="milk, cheddar, coffee…"
          aria-label="Search products"
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700 dark:focus:border-neutral-500"
        />
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Search
        </button>
      </form>

      {failure && (
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Could not reach the database: {failure}
        </div>
      )}

      {!failure && q && results.data && (
        <section className="mt-8">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {results.data.length === 0
              ? `No products matching “${q}”.`
              : `${results.data.length} result${results.data.length === 1 ? "" : "s"} for “${q}”, cheapest first.`}
          </p>
          <ul className="mt-2">
            {results.data.map((row) => (
              <PriceRow key={row.product_id} row={row} />
            ))}
          </ul>
          {results.data.some((row) => usualPrice(row) !== null) && (
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              “usually ~” is an estimated regular price for a deal the store
              does not mark as a sale, worked out from its own unit price.
            </p>
          )}
        </section>
      )}

      {!failure && !q && coverage.data && (
        <section className="mt-8 grid grid-cols-3 gap-4 border-t border-neutral-200 pt-6 dark:border-neutral-800">
          <div>
            <p className="text-xl font-semibold tabular-nums">
              {coverage.data.days}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              day{coverage.data.days === 1 ? "" : "s"} of history
            </p>
          </div>
          <div>
            <p className="text-xl font-semibold tabular-nums">
              {coverage.data.products.toLocaleString("en-CA")}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              products tracked
            </p>
          </div>
          <div>
            <p className="text-xl font-semibold tabular-nums">
              {coverage.data.observations.toLocaleString("en-CA")}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              price observations
            </p>
          </div>
        </section>
      )}

      <footer className="mt-12 border-t border-neutral-200 pt-6 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        Personal, non-commercial project. Not affiliated with any retailer.
      </footer>
    </main>
  );
}
