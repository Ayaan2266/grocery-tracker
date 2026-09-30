from decimal import Decimal

import pytest

from ingest.money import dollars_to_cents


@pytest.mark.parametrize(
    "value, expected",
    [
        ("1e100", None),
        ("1e-999999999", 0),
        ("NaN", None),
        ("Infinity", None),
        ("not a price", None),
    ],
)
def test_unusable_money_never_raises_a_decimal_error(value, expected) -> None:
    assert dollars_to_cents(value) == expected


def test_half_cents_round_up_using_decimal_arithmetic() -> None:
    assert dollars_to_cents(Decimal("1.005")) == 101
