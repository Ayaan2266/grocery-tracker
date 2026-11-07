"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

import type { SameItem } from "@/lib/matching";
import type { LatestPrice } from "@/lib/queries";
import { BANNER_COLORS, BANNER_SHORT, markDot, shortStoreNames, storeArea } from "@/lib/stores";
import { formatCents, formatUnitPrice } from "@/lib/utils";

/** A group longer than this shows its first few and folds the rest behind a button. */
const GROUP_FOLD_AFTER = 4;
const GROUP_SHOWN = 3;

/**
 * The same item at every store in scope, as a table grouped by price,
 * cheapest first: six stores at $1.25 read as one line, "$1.25 at 6 stores",
 * not six identical cards. Out-of-stock listings come last and are never
 * called cheapest.
 */
export function StoreComparison({
  items,
  currentId,
  query,
  marks,
}: {
  items: SameItem<LatestPrice>[];
  currentId: number;
  query: string;
  /** Each store's dot, as an index into STORE_MARKS. */
  marks: Map<number, number>;
}) {
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const listings = items.map((item) => item.listing);
  const otherCode = new Set(items.filter((item) => !item.byCode).map((item) => item.listing.product_id));
  const current = listings.find((l) => l.product_id === currentId) ?? null;
  const name = shortStoreNames(listings);

  const buyable = listings.filter((l) => l.in_stock);
  const out = listings.filter((l) => !l.in_stock);
  const cheapest = buyable.length ? Math.min(...buyable.map((l) => l.price_cents)) : null;
  const priciest = buyable.length ? Math.max(...buyable.map((l) => l.price_cents)) : null;
  // The page's own listing leads its group, so it is never folded away.
  const first = (a: LatestPrice, b: LatestPrice) =>
    Number(b.product_id === currentId) - Number(a.product_id === currentId) || name(a).localeCompare(name(b));

  const priced = [...Map.groupBy(buyable, (l) => l.price_cents).entries()]
    .sort(([a], [b]) => a - b)
    .map(([price, rows]) => ({ key: `p${price}`, price: price as number | null, rows: rows.sort(first) }));
  const groups = out.length ? [...priced, { key: "out", price: null, rows: out.sort(first) }] : priced;

  let pill: string | null = null;
  if (cheapest !== null && priciest !== null && priciest > cheapest) {
    if (current?.in_stock && current.price_cents === cheapest) {
      pill = `Cheapest here · save up to ${formatCents(priciest - cheapest)}`;
    } else if (current?.in_stock) {
      const best = buyable.filter((l) => l.price_cents === cheapest).sort(first)[0];
      pill = `${formatCents(current.price_cents - cheapest)} less at ${name(best)}`;
    } else {
      pill = `Prices differ by up to ${formatCents(priciest - cheapest)}`;
    }
  }

  const versus = (listing: LatestPrice) => {
    if (!current || listing.product_id === currentId) return { text: "—", tone: "" };
    const gap = listing.price_cents - current.price_cents;
    if (gap === 0) return { text: "Same price", tone: "" };
    const percent = Math.round((Math.abs(gap) / current.price_cents) * 100);
    return gap > 0
      ? { text: `+${formatCents(gap)} · ${percent}% more`, tone: "is-bad" }
      : { text: `${formatCents(-gap)} less · ${percent}% off`, tone: "is-good" };
  };

  return (
    <section className="store-compare" id="compare" aria-labelledby="compare-title">
      <div className="store-compare-header">
        <div>
          <h2 id="compare-title">Same item at other stores</h2>
          <p>Same product code, or the same brand, name and size. Latest price at each store.</p>
        </div>
        {pill && <span className="save-pill">{pill}</span>}
      </div>
      <div className="compare-table-wrap">
        <table className="compare-table">
          <thead>
            <tr>
              <th scope="col">Store</th>
              <th scope="col" className="col-num">Price</th>
              <th scope="col" className="col-num col-unit">Unit price</th>
              {current && <th scope="col" className="col-num col-vs">vs this listing</th>}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const folds = group.rows.length > GROUP_FOLD_AFTER && !opened.has(group.key);
              const rows = folds ? group.rows.slice(0, GROUP_SHOWN) : group.rows;
              const rest = group.rows.slice(GROUP_SHOWN);
              const isCheapest = group.price !== null && group.price === cheapest && buyable.length > 1;
              return (
                <Fragment key={group.key}>
                  <tr className="compare-group">
                    <th scope="colgroup" colSpan={current ? 4 : 3}>
                      {group.price === null ? (
                        <span className="compare-group-price">Out of stock</span>
                      ) : (
                        <span className="compare-group-price">{formatCents(group.price)}</span>
                      )}
                      <span className="compare-group-count">
                        {group.price === null ? "" : "at "}
                        {group.rows.length} store{group.rows.length === 1 ? "" : "s"}
                      </span>
                      {isCheapest && <small className="cheapest-badge">Cheapest</small>}
                    </th>
                  </tr>
                  {rows.map((listing) => {
                    const isCurrent = listing.product_id === currentId;
                    const dot = markDot(BANNER_COLORS[listing.banner_slug] ?? "#53617e", marks.get(listing.store_id));
                    const banner = BANNER_SHORT[listing.banner_slug] ?? listing.retailer_name;
                    const area = storeArea(listing.store_label);
                    const unit = formatUnitPrice(listing.unit_price_cents, listing.comparison_quantity, listing.comparison_unit);
                    const vs = versus(listing);
                    return (
                      <tr key={listing.product_id} className={isCurrent ? "is-current" : undefined}>
                        <td>
                          <span className="compare-store">
                            <i className={["store-dot", dot.className].filter(Boolean).join(" ")} style={dot.style} aria-hidden="true" />
                            {isCurrent ? (
                              <strong>{banner}</strong>
                            ) : (
                              <Link href={`/product/${listing.product_id}?${new URLSearchParams({ q: query })}`}>{banner}</Link>
                            )}
                            {area && <span className="store-area">{area}</span>}
                            {isCurrent && <small className="this-badge">This listing</small>}
                            {otherCode.has(listing.product_id) && <small>Another product code</small>}
                            {!listing.in_stock && <small className="stock-badge">Out of stock</small>}
                          </span>
                        </td>
                        <td className="col-num compare-price">
                          {formatCents(listing.price_cents)}
                          {unit && <small className="compare-unit-inline">{unit}</small>}
                        </td>
                        <td className="col-num col-unit">{unit ?? "—"}</td>
                        {current && <td className={`col-num col-vs ${vs.tone}`}>{vs.text}</td>}
                      </tr>
                    );
                  })}
                  {folds && (
                    <tr className="compare-more">
                      <td colSpan={current ? 4 : 3}>
                        <button type="button" onClick={() => setOpened(new Set(opened).add(group.key))}>
                          {rest.length} more store{rest.length === 1 ? "" : "s"}
                          {group.price === null ? "" : ` at ${formatCents(group.price)}`}: {rest.map(name).join(", ")}
                          <ChevronDown size={15} strokeWidth={2.6} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
