"""Turn a raw PCX product entry into a row we can store.

This is a validation layer over the API's own `comparisonPrices`, not a
parser. The parser is a fallback for entries that come back without one.

The unit vocabulary was settled against real data on 2026-09-22. Across 19,649
stored products, `packageSize` used exactly five units:

    g 10,770 | ml 4,345 | ea 1,796 | l 1,503 | kg 1,212 | other 23 (0.12%)

and across 315 live products the API's own `comparisonPrices` used exactly
three `(unit, quantity)` pairs: `(g, 100)`, `(ml, 100)`, `(ea, 1)`.

Both are folded onto the same three canonical dimensions below. That matters
because `comparison_unit` is a join key: two products only compare if their
units agree exactly, so `1 l` and `1000 ml` have to end up identical or 13.8%
of the catalogue (everything written in `l` or `kg`) becomes unreachable.

Grams, millilitres and each are deliberately NOT comparable with one another.
The density to convert mass to volume is not in the payload, and `ea` has no
magnitude at all. Keeping the unit on the row is what stops a downstream query
comparing across them by accident.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from decimal import Decimal, DecimalException
from typing import Any, Literal

from ingest.money import dollars_to_cents
from ingest.sources.loblaw import Price, Product

log = logging.getLogger(__name__)

# "api"     -- the API's comparisonPrices supplied it
# "derived" -- computed from the shelf price and a parsed packageSize
# "none"    -- neither worked
#
# Stored per observation so a bug in the derivation can be found and corrected
# later without re-deriving the whole table or distrusting API-supplied values.
UnitPriceSource = Literal["api", "derived", "none"]

IN_STOCK_STATUS = "OK"

# Above this relative gap, an API unit price and the one the package size
# implies are treated as disagreeing rather than rounding differently.
DISAGREEMENT_TOLERANCE = Decimal("0.02")

# Every unit seen in the wild, mapped onto a canonical dimension and the factor
# that converts a quantity in that unit into the canonical one. Anything absent
# (m, sh, pk, mm -- 23 rows between them) yields no unit price rather than a
# wrong one.
UNIT_CONVERSIONS: dict[str, tuple[str, Decimal]] = {
    "g": ("g", Decimal(1)),
    "kg": ("g", Decimal(1000)),
    "ml": ("ml", Decimal(1)),
    "l": ("ml", Decimal(1000)),
    "ea": ("ea", Decimal(1)),
}

# What the API reports a unit price per: $/100 g, $/100 ml, $/1 ea. The derived
# path follows the same convention so the two are directly comparable.
CANONICAL_QUANTITY: dict[str, Decimal] = {
    "g": Decimal(100),
    "ml": Decimal(100),
    "ea": Decimal(1),
}

# "500 g", "1.89 l", "1 ea", and the one multi-pack form: "12x355.0 ml".
_PACKAGE_SIZE_RE = re.compile(
    r"""^\s*
        (?:(?P<count>\d+(?:\.\d+)?)\s*[x×]\s*)?   # optional "12x"
        (?P<size>\d+(?:\.\d+)?)\s*
        (?P<unit>[a-z]+)
        \s*$""",
    re.IGNORECASE | re.VERBOSE,
)


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


def _to_decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = Decimal(str(value))
    except (DecimalException, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def canonicalize(unit: Any, quantity: Decimal) -> tuple[str, Decimal] | None:
    """Fold a (unit, quantity) pair onto the canonical vocabulary.

    Shared by both paths on purpose. If the API path and the parser used
    different tables they could disagree about what a gram is, and the
    disagreement would only surface as a wrong comparison months later.
    """
    if unit is None:
        return None
    mapping = UNIT_CONVERSIONS.get(str(unit).strip().lower())
    if mapping is None:
        return None
    canonical_unit, factor = mapping
    return canonical_unit, quantity * factor


def extract_unit_price(comparison_prices: list[dict[str, Any]]) -> UnitPrice | None:
    """Read the API's pre-normalized unit price.

    Takes the first entry. Verified on 2026-09-22: of 315 live products across
    six categories, including 90 on sale, none had more than one entry, so
    there is no selection to make.

    The `type` field is a trap. It reads "REGULAR" even on a discounted item,
    but the value tracks the CURRENT selling price: Triple Cheddar at $4.99
    (was $6.00) in a 320 g pack reported $1.56/100 g, and 1.56 x 3.2 = 4.99,
    not 6.00. So `type` must not be used to pick or reject an entry -- doing so
    would silently pair a sale shelf price with a regular-price unit price.

    An empty list is the documented common case, not an error.
    """
    if not comparison_prices:
        return None

    entry = comparison_prices[0]
    if not isinstance(entry, dict):
        return None

    cents = dollars_to_cents(entry.get("value"))
    if cents is None or cents < 0:
        return None

    quantity = _to_decimal(entry.get("quantity"))
    if quantity is None or quantity <= 0:
        return None

    canonical = canonicalize(entry.get("unit"), quantity)
    if canonical is None:
        return None

    canonical_unit, canonical_quantity = canonical
    return UnitPrice(
        cents=cents,
        unit=canonical_unit,
        quantity=canonical_quantity,
        source="api",
    )


def parse_package_size(package_size: str) -> tuple[Decimal, str] | None:
    """Parse `packageSize` into a canonical (value, unit).

    The strings are machine-generated and follow one grammar, `<number> <unit>`,
    with a single multi-pack variant, `<count>x<size> <unit>` (199 rows, e.g.
    "12x355.0 ml"). No ranges, no "approx", no casing drift.

    A multi-pack returns the TOTAL, because this feeds the unit price and the
    shelf price buys the whole pack. `size_value` therefore answers "how much
    is in the box", not "how big is one of them" -- if matching later needs to
    tell a 12-pack from a single can, that wants its own pack_count column
    rather than a second meaning for this one.

    Returns None for anything outside the unit table. None is a good answer:
    it keeps a guess out of a column that feeds product identity, where a bad
    parse corrupts match candidates as well as the unit price.
    """
    if not package_size:
        return None

    match = _PACKAGE_SIZE_RE.match(package_size)
    if match is None:
        return None

    size = _to_decimal(match.group("size"))
    if size is None or size <= 0:
        return None

    count = _to_decimal(match.group("count")) if match.group("count") else Decimal(1)
    if count is None or count <= 0:
        return None

    canonical = canonicalize(match.group("unit"), size * count)
    if canonical is None:
        return None

    canonical_unit, total = canonical
    return total, canonical_unit


def derive_unit_price(price_cents: int, size_value: Decimal, size_unit: str) -> UnitPrice | None:
    """Compute a unit price from the shelf price and a parsed package size.

    Follows the API's own convention -- per 100 g, per 100 ml, per 1 ea -- so a
    derived value sits on the same scale as an API-supplied one and the two can
    be compared against each other.
    """
    quantity = CANONICAL_QUANTITY.get(size_unit)
    if quantity is None or size_value <= 0:
        return None

    cents = dollars_to_cents(Decimal(price_cents) * quantity / size_value / 100)
    if cents is None or cents < 0:
        return None

    return UnitPrice(cents=cents, unit=size_unit, quantity=quantity, source="derived")


def unit_price_disagreement(row: NormalizedPrice) -> Decimal | None:
    """Relative gap between an API unit price and the one the size implies.

    Returns None when there is nothing to compare. Both routes agreed on every
    product checked by hand, so a run where this starts firing means something
    moved: a packageSize parsed wrong, the API changing which price the
    comparison tracks, or a units mismatch creeping in. Cheap to compute and it
    turns a silent corruption into a number in the nightly summary.
    """
    if row.unit_price_source != "api" or row.unit_price_cents is None:
        return None
    if row.size_value is None or row.size_unit is None or row.size_value <= 0:
        return None
    if row.comparison_unit != row.size_unit:
        return None

    derived = derive_unit_price(row.price_cents, row.size_value, row.size_unit)
    if derived is None or derived.cents == 0:
        return None

    difference = abs(row.unit_price_cents - derived.cents)
    if difference <= 1:
        # The two paths round independently, so a cent apart is agreement.
        return Decimal(0)

    scale = max(row.unit_price_cents, derived.cents, 1)
    return Decimal(difference) / Decimal(scale)


def _was_price_cents(was_price: Price | float | None) -> int | None:
    """wasPrice arrives as an object with .value; a bare number is tolerated."""
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

    # Always parsed, whether or not the API supplies a unit price: size_value
    # and size_unit are product identity fields that match.py will lean on.
    size_value: Decimal | None = None
    size_unit: str | None = None
    if entry.package_size:
        parsed = parse_package_size(entry.package_size)
        if parsed is not None:
            size_value, size_unit = parsed

    unit_price = extract_unit_price(entry.prices.comparison_prices)
    if unit_price is None and size_value is not None and size_unit is not None:
        unit_price = derive_unit_price(price_cents, size_value, size_unit)

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
