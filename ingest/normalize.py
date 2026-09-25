"""Turn a raw PCX product entry into a row we can store.

The stored unit price is the shelf price divided by the package size: the
price you actually pay, per 100 g, per 100 ml or per 1 each. The API's own
`comparisonPrices` is only a fallback, for the ~0.1% of products whose
packageSize will not parse, and a nightly cross-check on the rest.

It used to be the other way round, with the API's figure trusted first. The
first live check (2026-09-23) showed why not: on 21% of Superstore products,
and occasionally elsewhere, the shelf price is discounted with no wasPrice, and
the API's unit price still follows the regular price. Mango Nectar, 960 ml at
$1.50, came back as $0.24/100 ml -- a $2.30 bottle. Taking the API's word
there stores a unit price that no customer paid.

The unit vocabulary was settled against real data on 2026-09-22. Across 19,649
stored products, `packageSize` used exactly five units:

    g 10,770 | ml 4,345 | ea 1,796 | l 1,503 | kg 1,212 | other 23 (0.12%)

and across 315 live products the API's own `comparisonPrices` used three
`(unit, quantity)` pairs: `(g, 100)`, `(ml, 100)`, `(ea, 1)`. The full nightly
run later turned up per 1000 g, per 10 ml and per 100 ea as well, so API
figures are rescaled onto the same per-100 / per-1 basis before use.

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
from dataclasses import dataclass, replace
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
    """One product observed at one store on one day.

    Maps 1:1 onto the schema, apart from api_unit_price_cents.
    """

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
    # The regular price the API's unit price implies, on a deal that has no
    # wasPrice. Inferred, so kept apart from was_price_cents. See
    # implied_regular_cents().
    implied_regular_cents: int | None = None
    # The API's unit price on the same basis as unit_price_cents, when it gave
    # one in the same unit. Kept for the nightly cross-check only; not stored.
    api_unit_price_cents: int | None = None

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

    That holds for sales that set wasPrice. Deals that do not -- most of them at
    Superstore -- keep a unit price on the regular price, which is why
    normalize_entry only falls back to this. See the module docstring.

    An empty list is the documented common case, not an error.
    """
    rate = api_rate(comparison_prices)
    if rate is None:
        return None

    # $36.18 per 1000 g and $3.62 per 100 g are the same price, but only the
    # second compares directly with every other gram-priced product. Rescale
    # onto the basis derive_unit_price uses, from the unrounded rate.
    canonical_unit, dollars_per_one = rate
    per = CANONICAL_QUANTITY[canonical_unit]
    cents = dollars_to_cents(dollars_per_one * per)
    if cents is None:
        return None

    return UnitPrice(cents=cents, unit=canonical_unit, quantity=per, source="api")


def api_rate(comparison_prices: list[dict[str, Any]]) -> tuple[str, Decimal] | None:
    """The API's first comparison price as (canonical unit, dollars per one of it).

    Unrounded, so a price rebuilt from it for a whole package carries only the
    API's own rounding, not a second rounding to the cent per 100 g.
    """
    if not comparison_prices:
        return None

    entry = comparison_prices[0]
    if not isinstance(entry, dict):
        return None

    value = _to_decimal(entry.get("value"))
    if value is None or value < 0:
        return None

    quantity = _to_decimal(entry.get("quantity"))
    if quantity is None or quantity <= 0:
        return None

    canonical = canonicalize(entry.get("unit"), quantity)
    if canonical is None:
        return None

    canonical_unit, canonical_quantity = canonical
    return canonical_unit, value / canonical_quantity


@dataclass(frozen=True)
class Package:
    """A parsed packageSize: how many items, and how much in all of them."""

    count: Decimal
    total: Decimal
    unit: str


def parse_package(package_size: str) -> Package | None:
    """Parse `packageSize` keeping the pack count, which matching needs.

    6x710 ml and 12x355 ml hold the same 4,260 ml and are not the same
    product. See parse_package_size for the grammar.
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
    return Package(count=count, total=total, unit=canonical_unit)


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
    package = parse_package(package_size)
    if package is None:
        return None
    return package.total, package.unit


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
    """Relative gap between the API's unit price and the stored, shelf-price one.

    Returns None when there is nothing to compare. Nothing stored depends on
    this any more; it is a number in the nightly summary. Its baseline is the
    deals the API prices at the regular rate (about 1,400 a night, nearly all
    at Superstore), so a jump well past that means something else moved: a
    packageSize parsing wrong, or the API changing what its figure tracks.
    """
    if row.api_unit_price_cents is None or row.unit_price_source != "derived":
        return None
    if row.unit_price_cents is None or row.unit_price_cents == 0:
        return None

    difference = abs(row.api_unit_price_cents - row.unit_price_cents)
    if difference <= 1:
        # The two paths round independently, so a cent apart is agreement.
        return Decimal(0)

    scale = max(row.api_unit_price_cents, row.unit_price_cents, 1)
    return Decimal(difference) / Decimal(scale)


def implied_regular_cents(row: NormalizedPrice, dollars_per_one: Decimal) -> int | None:
    """The regular price behind a deal the API does not mark as one.

    On these deals the shelf price is discounted, wasPrice is absent, and the
    API's unit price stays on the regular price (see the module docstring).
    That unit price times the package size is the regular price, which is the
    "is this really a deal" signal the project exists for.

    Returns None unless all of these hold: no wasPrice (a declared sale already
    says what it was), the API's unit price is the higher of the two, and the
    gap is past the same tolerance the nightly check uses, so rounding noise
    is never stored as a deal.

    Approximate. The API rounds its unit price to the cent per its quantity, so
    the result can be off by half a cent per 100 g of package: about 3 cents on
    a 540 g loaf, 21 cents on a 6x710 ml pack.
    """
    if row.was_price_cents is not None or row.size_value is None:
        return None
    if row.api_unit_price_cents is None or row.unit_price_cents is None:
        return None
    if row.api_unit_price_cents <= row.unit_price_cents:
        return None

    gap = unit_price_disagreement(row)
    if gap is None or gap <= DISAGREEMENT_TOLERANCE:
        return None

    regular = dollars_to_cents(dollars_per_one * row.size_value)
    if regular is None or regular <= row.price_cents:
        return None
    return regular


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

    # size_value and size_unit are product identity fields that match.py will
    # lean on, as well as the basis of the unit price.
    size_value: Decimal | None = None
    size_unit: str | None = None
    if entry.package_size:
        parsed = parse_package_size(entry.package_size)
        if parsed is not None:
            size_value, size_unit = parsed

    derived = None
    if size_value is not None and size_unit is not None:
        derived = derive_unit_price(price_cents, size_value, size_unit)
    rate = api_rate(entry.prices.comparison_prices)
    api = extract_unit_price(entry.prices.comparison_prices)
    unit_price = derived or api

    row = NormalizedPrice(
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
        api_unit_price_cents=api.cents if api and derived and api.unit == derived.unit else None,
    )
    if rate is None:
        return row
    return replace(row, implied_regular_cents=implied_regular_cents(row, rate[1]))
