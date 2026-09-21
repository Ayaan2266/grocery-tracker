const STATUS = [
  { label: "Ingestion", detail: "Loblaw PCX client, nightly GitHub Action", done: true },
  { label: "Schema", detail: "Append-only price_observations on Supabase", done: true },
  { label: "Price history chart", detail: "Recharts over observed_on", done: false },
  { label: "Cross-banner matching", detail: "See ingest/match.py", done: false },
  { label: "Basket optimizer", detail: "Cheapest store combination near a postal code", done: false },
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
          Building in public · week 1
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Canadian grocery price history
        </h1>
        <p className="text-base leading-relaxed text-neutral-600 dark:text-neutral-400">
          Flyer apps tell you what is on sale this week. None of them tell you whether
          $4.99 is actually a good price or just the usual price with a sale sticker on
          it. This tracks store-level prices daily so that question has an answer.
        </p>
      </header>

      <ul className="space-y-2.5">
        {STATUS.map((item) => (
          <li key={item.label} className="flex items-start gap-3 text-sm">
            <span
              aria-hidden
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                item.done ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-700"
              }`}
            />
            <span>
              <span className="font-medium">{item.label}</span>
              <span className="text-neutral-500 dark:text-neutral-400"> — {item.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      <footer className="text-sm text-neutral-500 dark:text-neutral-400">
        Personal, non-commercial project. Not affiliated with any retailer.
      </footer>
    </main>
  );
}
