"""Turn a raw PCX product into the fields the database stores.

Most of the work this module was originally budgeted for does not exist. The
API already returns `comparisonPrices` normalized to $/100g or $/100ml, so the
primary path is extraction plus validation, not parsing.

What remains is the fallback: some products come back with an empty
`comparisonPrices` (notably SOLD_BY_EACH items and some weighted produce). For
those, unit price has to be derived from `packageSize`, which is free text:

    "4 l", "2 x 250 g", "500g", "12x355ml", "approx 1.2 kg", "6 ct"

`parse_package_size` is where that lives, and it is deliberately unimplemented.
Decide these before you write it:

  * Multi-packs. Is "2 x 250 g" 500 g, or two units of 250 g? For $/100g it is
    500 g. For "cheapest per unit" it is not. Pick one and write it down.
  * Count units ("6 ct", "dozen"). There is no mass. Either emit a `count`
    unit that never gets compared against mass, or refuse to normalize.
  * Approximate weights ("approx 1.2 kg"). A derived unit price on a weighted
    item is an estimate. If you store it, flag it, or your "is this a good
    deal" answer quietly inherits an error bar you never told the user about.
  * Unparseable strings. Store the observation with a NULL unit price rather
    than dropping the row. Price history is the point; unit price is a
    convenience column.

Whatever you choose, write a test per case in tests/test_normalize.py. That
file is a decision log as much as a test suite.
"""

from __future__ import annotations

from dataclasses import dataclass

from ingest.models import Product

# Units the database is willing to compare against each other.
MASS_UNITS = {"g", "kg"}
VOLUME_UNITS = {"ml", "l"}


@dataclass(frozen=True)
class NormalizedPrice:
    retailer_sku: str
    raw_name: str
    brand: str | None
    package_size: str | None
    price_cents: int | None
    was_price_cents: int | None
    unit_price_cents: int | None  # per comparison_quantity of comparison_unit
    comparison_unit: str | None
    comparison_quantity: float | None
    in_stock: bool
    unit_price_source: str  # "api" | "derived" | "none"


def to_cents(value: float | None) -> int | None:
    """Money is stored as integer cents. Never float dollars in the database."""
    if value is None:
        return None
    return int(round(value * 100))


def parse_package_size(package_size: str) -> tuple[float, str] | None:
    """Derive (quantity, unit) from a free-text package size.

    Returns the total quantity in a comparable unit, or None when the string
    cannot be resolved into one. See the module docstring for the decisions
    this function encodes.
    """
    raise NotImplementedError("Ayaan writes this. See module docstring for the decisions.")


def normalize(product: Product) -> NormalizedPrice:
    """Extract the storable shape of one product observation.

    Never raises on a weird product. A product that cannot be normalized still
    produces a row with NULL unit price, because dropping it loses a day of
    price history that cannot be recovered later.
    """
    prices = product.prices
    price_cents = to_cents(prices.price.value) if prices and prices.price else None
    was_price_cents = to_cents(prices.wasPrice.value) if prices and prices.wasPrice else None

    unit_price_cents: int | None = None
    comparison_unit: str | None = None
    comparison_quantity: float | None = None
    source = "none"

    comparisons = prices.comparisonPrices if prices else []
    usable = next(
        (
            c
            for c in comparisons
            if c.value is not None and c.unit in (MASS_UNITS | VOLUME_UNITS) and c.quantity
        ),
        None,
    )
    if usable is not None:
        unit_price_cents = to_cents(usable.value)
        comparison_unit = usable.unit
        comparison_quantity = usable.quantity
        source = "api"
    elif product.packageSize:
        try:
            parsed = parse_package_size(product.packageSize)
        except NotImplementedError:
            parsed = None
        if parsed and price_cents is not None:
            total_quantity, unit = parsed
            if total_quantity > 0:
                unit_price_cents = int(round(price_cents / total_quantity * 100))
                comparison_unit = unit
                comparison_quantity = 100.0
                source = "derived"

    return NormalizedPrice(
        retailer_sku=product.code,
        raw_name=product.name,
        brand=product.brand,
        package_size=product.packageSize,
        price_cents=price_cents,
        was_price_cents=was_price_cents,
        unit_price_cents=unit_price_cents,
        comparison_unit=comparison_unit,
        comparison_quantity=comparison_quantity,
        in_stock=(product.stockStatus or "").upper() == "OK",
        unit_price_source=source,
    )


def is_on_sale(normalized: NormalizedPrice) -> bool:
    """A non-null wasPrice above the current price is the only sale signal the
    API gives. Note this says nothing about whether the sale price is actually
    good -- that question needs price_observations history, which is the whole
    point of the project."""
    return (
        normalized.was_price_cents is not None
        and normalized.price_cents is not None
        and normalized.was_price_cents > normalized.price_cents
    )
