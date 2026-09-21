"""Turn a raw PCX product entry into a row we can store.

WHAT IS IMPLEMENTED HERE is the mechanical half: shelf price and sale price
into integer cents, the stock flag, the identity fields.

WHAT IS YOURS TO WRITE is `extract_unit_price` and `parse_package_size`. Both
currently return None, so every row lands with unit_price_source="none" and a
NULL unit price. That is the documented current behaviour (see "What doesn't
work yet" in the README) and it is deliberate: a NULL unit price is a gap you
can fill later, a *wrong* one silently poisons every comparison built on top
of it and you will not know which rows to distrust.

This module is a validation layer over the API's own `comparisonPrices`, not a
parser. The parser only runs as a fallback for entries that come back with an
empty `comparisonPrices` -- mostly sold-by-each items and weighted produce.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal

from ingest.money import dollars_to_cents
from ingest.sources.loblaw import Price, Product

# "api"     -- the API's comparisonPrices supplied it
# "derived" -- parse_package_size computed it from packageSize
# "none"    -- neither worked
#
# Stored per observation so a bug in the derivation can be found and corrected
# later without re-deriving the whole table or distrusting API-supplied values.
UnitPriceSource = Literal["api", "derived", "none"]

IN_STOCK_STATUS = "OK"


@dataclass(frozen=True)
class UnitPrice:
    cents: int
    unit: str
    quantity: Decimal
    source: UnitPriceSource


@dataclass(frozen=True)
class NormalizedPrice:
    """One product observed at one store on one day. Maps 1:1 onto the schema."""

    retailer_sku: str
    raw_name: str
    brand: str | None
    package_size: str | None
    size_value: Decimal | None
    size_unit: str | None
    price_cents: int
    was_price_cents: int | None
    unit_price_cents: int | None
    comparison_unit: str | None
    comparison_quantity: Decimal | None
    unit_price_source: UnitPriceSource
    in_stock: bool

    @property
    def on_sale(self) -> bool:
        """wasPrice is non-null only when the item is on sale."""
        return self.was_price_cents is not None


def _was_price_cents(was_price: Price | float | None) -> int | None:
    """wasPrice arrives either as an object with .value or as a bare number."""
    if was_price is None:
        return None
    if isinstance(was_price, Price):
        return dollars_to_cents(was_price.value)
    return dollars_to_cents(was_price)


def normalize_entry(entry: Product) -> NormalizedPrice | None:
    """Normalize one search result. Returns None when there is no usable price."""
    if entry.prices is None or entry.prices.price is None:
        return None

    price_cents = dollars_to_cents(entry.prices.price.value)
    if price_cents is None or price_cents < 0:
        return None

    unit_price = extract_unit_price(entry.prices.comparison_prices)

    size_value: Decimal | None = None
    size_unit: str | None = None
    if unit_price is None and entry.package_size:
        parsed = parse_package_size(entry.package_size)
        if parsed is not None:
            size_value, size_unit = parsed

    return NormalizedPrice(
        retailer_sku=entry.code,
        raw_name=entry.name,
        brand=entry.brand,
        package_size=entry.package_size,
        size_value=size_value,
        size_unit=size_unit,
        price_cents=price_cents,
        was_price_cents=_was_price_cents(entry.prices.was_price),
        unit_price_cents=unit_price.cents if unit_price else None,
        comparison_unit=unit_price.unit if unit_price else None,
        comparison_quantity=unit_price.quantity if unit_price else None,
        unit_price_source=unit_price.source if unit_price else "none",
        in_stock=entry.stock_status == IN_STOCK_STATUS,
    )


def extract_unit_price(comparison_prices: list[dict[str, Any]]) -> UnitPrice | None:
    """YOURS TO WRITE. Read the API's pre-normalized unit price.

    Input is the raw `prices.comparisonPrices` list, carried through unparsed
    because its inner shape was never verified against the live API. Dump one
    real response and look before you write anything here.

    Return a UnitPrice with source="api", or None to leave the column NULL.

    The decisions this function has to make, none of which have an obviously
    correct answer:

    1. The list can hold more than one entry -- e.g. $/100g and $/kg for the
       same item. Whichever you pick becomes the number every comparison in the
       app is built on. Picking `[0]` is a real choice; make it on purpose and
       write down why.

    2. Unit strings are not a closed set. Expect "100g", "100 g", "100ml",
       "1ea" and casing drift. Whatever you store lands in `comparison_unit`,
       and two products only compare if their units agree *exactly* -- so this
       is a join key, not a display label.

    3. $/100g and $/100ml are not comparable and the density to convert between
       them is not in the payload. The unit therefore belongs in the comparison
       key, never silently dropped.

    4. Use `dollars_to_cents` from ingest.money, not a second rounding rule. If
       unit price and shelf price round differently they will disagree on items
       where they should reconcile, and that is a miserable bug to find later.

    5. An empty list is the common, documented case, not an error. Return None.
    """
    return None


def parse_package_size(package_size: str) -> tuple[Decimal, str] | None:
    """YOURS TO WRITE. Fallback parser for entries with no comparisonPrices.

    Return (value, canonical_unit), or None when the string cannot be parsed
    confidently. None is a perfectly good answer -- it is what keeps a guess
    out of the database.

    Note this feeds `size_value` / `size_unit` on `products`, which are product
    *identity* fields that match.py will lean on. A bad parse here does not
    just produce a wrong unit price, it corrupts match candidates too.

    The cases that will actually show up:

    1. Multi-packs: "12 x 355 mL". Total volume or per-unit? The answer decides
       whether a 12-pack looks cheaper or dearer than a single can, and both
       readings are defensible -- so pick one and be consistent.

    2. Approximates and ranges: "approx 450 g", "0.5 - 0.7 kg" on weighted
       meat. A midpoint is a guess that stops looking like a guess the moment
       it is a number in a column. Returning None may be the better answer.

    3. Casing and spacing drift: "4L", "4 L", "4l".

    4. Compound strings: "500 g (2 x 250 g)" -- two parseable sizes, one of
       which is a subdivision of the other.

    5. Count-only and non-metric: "6 ct", "each", "1 dozen". These have no mass
       or volume at all. Decide whether "ea" is a unit you support or a signal
       to give up.

    6. Canonicalisation: is 4 L stored as (4, "L") or (4000, "ml")? Storing a
       canonical unit makes comparison trivial and loses the retailer's own
       phrasing; storing it verbatim keeps fidelity and pushes the problem
       downstream. `package_size` already keeps the raw string, which argues
       for canonicalising here.
    """
    return None
