import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Prices are stored as integer cents. Format at the edge, never in the DB. */
export function formatCents(cents: number | null): string {
  if (cents === null) return "—";
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
  }).format(cents / 100);
}

/** "$1.56/100g". Returns null when there is no unit price to show. */
export function formatUnitPrice(
  cents: number | null,
  quantity: number | null,
  unit: string | null,
): string | null {
  if (cents === null || quantity === null || !unit) return null;
  const amount = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
  }).format(cents / 100);
  return unit === "ea" ? `${amount} each` : `${amount}/${quantity}${unit}`;
}

/** "Sep 22" for an ISO date, without dragging in a date library. */
export function formatDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
