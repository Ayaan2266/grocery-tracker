"""Money handling.

Prices are integer cents everywhere -- in the database, in the pydantic models
and in anything the frontend consumes. Formatting happens once, at the edge,
in the web app's formatCents.

The API hands us dollars as JSON floats. float(6.44) * 100 is 643.9999...,
so the conversion goes through Decimal(str(value)) and rounds half-up. Using
round() directly would apply banker's rounding and disagree with the
retailer's own arithmetic on exact half-cents.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

_CENT = Decimal("1")


def dollars_to_cents(value: float | int | str | None) -> int | None:
    """Convert a dollar amount to integer cents. None passes through."""
    if value is None:
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite():
        return None
    return int((amount * 100).quantize(_CENT, rounding=ROUND_HALF_UP))
