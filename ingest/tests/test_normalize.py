"""Normalization tests.

The unit-price stubs are intentionally unimplemented, so the assertions here
cover the mechanical half and pin the *current* documented behaviour: a NULL
unit price with source "none". When extract_unit_price lands, the test named
below is the one that changes.
"""

from __future__ import annotations

from ingest.money import dollars_to_cents
from ingest.normalize import normalize_entry
from ingest.sources.loblaw import Product
from ingest.tests.conftest import product_entry


def parse(**overrides):
    return normalize_entry(Product.model_validate(product_entry(**overrides)))


class TestDollarsToCents:
    def test_verified_shelf_prices(self) -> None:
        assert dollars_to_cents(6.44) == 644
        assert dollars_to_cents(5.94) == 594
        assert dollars_to_cents(7.18) == 718

    def test_exact_half_cents_round_up_not_to_even(self) -> None:
        # Python's round() is banker's rounding: it breaks an exact tie toward
        # the even number, so 0.045 -> 4 and 0.065 -> 6. Retail arithmetic
        # rounds a half up. Sub-cent values are not hypothetical here --
        # comparisonPrices are dollars per 100 g and routinely land under a
        # cent, so this is the path the unit price will take once the stub
        # is implemented.
        assert dollars_to_cents(0.045) == 5
        assert round(0.045 * 100) == 4

        assert dollars_to_cents(0.065) == 7
        assert round(0.065 * 100) == 6

    def test_accepts_strings_and_ints(self) -> None:
        assert dollars_to_cents("3.99") == 399
        assert dollars_to_cents(4) == 400

    def test_none_and_nonsense_pass_through_as_none(self) -> None:
        assert dollars_to_cents(None) is None
        assert dollars_to_cents("not a price") is None
        assert dollars_to_cents(float("nan")) is None
        assert dollars_to_cents(float("inf")) is None

    def test_zero_is_a_price_not_a_missing_value(self) -> None:
        assert dollars_to_cents(0) == 0


class TestNormalizeEntry:
    def test_identity_and_price_fields(self) -> None:
        row = parse()
        assert row is not None
        assert row.retailer_sku == "20188873_EA"
        assert row.raw_name == "2% Milk"
        assert row.brand == "Neilson"
        assert row.package_size == "4 L"
        assert row.price_cents == 644
        assert row.in_stock is True

    def test_no_was_price_means_not_on_sale(self) -> None:
        row = parse()
        assert row is not None
        assert row.was_price_cents is None
        assert row.on_sale is False

    def test_was_price_as_object(self) -> None:
        row = parse(prices={"price": {"value": 4.99}, "wasPrice": {"value": 6.44}})
        assert row is not None
        assert row.price_cents == 499
        assert row.was_price_cents == 644
        assert row.on_sale is True

    def test_was_price_as_bare_number(self) -> None:
        """The shape was never pinned down upstream, so both are accepted."""
        row = parse(prices={"price": {"value": 4.99}, "wasPrice": 6.44})
        assert row is not None
        assert row.was_price_cents == 644
        assert row.on_sale is True

    def test_out_of_stock_is_recorded_not_dropped(self) -> None:
        row = parse(stockStatus="OUT_OF_STOCK")
        assert row is not None
        assert row.in_stock is False
        assert row.price_cents == 644

    def test_entry_without_prices_is_skipped(self) -> None:
        assert parse(prices=None) is None

    def test_entry_without_a_price_value_is_skipped(self) -> None:
        assert parse(prices={"wasPrice": None, "comparisonPrices": []}) is None

    def test_unit_price_is_null_until_extract_unit_price_is_written(self) -> None:
        """Documented current behaviour. Update this when the stub lands."""
        row = parse(
            prices={
                "price": {"value": 6.44},
                "comparisonPrices": [{"value": 0.16, "unit": "100ml"}],
            }
        )
        assert row is not None
        assert row.unit_price_cents is None
        assert row.comparison_unit is None
        assert row.unit_price_source == "none"
