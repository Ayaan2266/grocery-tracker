"use client";

import Form from "next/form";
import type { ChangeEvent } from "react";

import { DEALS, MIN_CHANGES, SORTS, type ChangeFilters, type Direction } from "@/lib/changes";
import { BANNER_SHORT } from "@/lib/stores";

/**
 * Chain, deal and size filters and the sort order for the price-changes page. A GET form like
 * the search box, so every filtered view is a shareable URL and it works
 * before JavaScript loads (the Apply button); once it has, picking an option
 * applies it at once, without moving the page.
 */
export function ChangesFilters({
  direction,
  store,
  chains,
  filters,
}: {
  direction: Direction;
  store: number | null;
  /** Banner slugs of the stores in scope, in display order. */
  chains: string[];
  filters: ChangeFilters;
}) {
  const apply = (event: ChangeEvent<HTMLSelectElement>) => {
    const form = event.currentTarget.form;
    if (!form) return;
    // A disabled field is left out of the URL, so "All chains" and "Any size"
    // make no empty chain= or min=. The form is rebuilt after the navigation.
    for (const select of form.querySelectorAll("select")) select.disabled = select.value === "";
    form.requestSubmit();
  };
  return (
    <Form action="/changes" scroll={false} className="changes-filters" aria-label="Filter price changes">
      {direction === "up" && <input type="hidden" name="dir" value="up" />}
      {store !== null && <input type="hidden" name="store" value={store} />}
      {chains.length > 1 && (
        <label className="changes-filter">
          <span>Chain</span>
          <select id="filter-chain" name="chain" defaultValue={filters.chain ?? ""} onChange={apply}>
            <option value="">All chains</option>
            {chains.map((slug) => (
              <option key={slug} value={slug}>{BANNER_SHORT[slug] ?? slug}</option>
            ))}
          </select>
        </label>
      )}
      <label className="changes-filter">
        <span>Deal</span>
        <select id="filter-deal" name="deal" defaultValue={filters.deal ?? ""} onChange={apply}>
          <option value="">Any change</option>
          {DEALS[direction].map((deal) => (
            <option key={deal.value} value={deal.value}>{deal.label}</option>
          ))}
        </select>
      </label>
      <label className="changes-filter">
        <span>Size</span>
        <select id="filter-min" name="min" defaultValue={filters.min === null ? "" : String(filters.min)} onChange={apply}>
          <option value="">Any size</option>
          {MIN_CHANGES.map((min) => (
            <option key={min} value={min}>{min}% or more</option>
          ))}
        </select>
      </label>
      <label className="changes-filter">
        <span>Sort</span>
        <select id="filter-sort" name="sort" defaultValue={filters.sort === undefined || filters.sort === "change" ? "" : filters.sort} onChange={apply}>
          {SORTS.map((sort) => (
            <option key={sort.value} value={sort.value === "change" ? "" : sort.value}>{sort.label}</option>
          ))}
        </select>
      </label>
      <noscript>
        <button type="submit" className="changes-filter-apply">Apply</button>
      </noscript>
    </Form>
  );
}
