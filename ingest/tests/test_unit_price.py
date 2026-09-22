"""Unit-price tests, built from values observed live on 2026-09-22.

Where a number here looks arbitrary it came off the real API or out of the
products table, and the docstring says which.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from ingest.normalize import (
    derive_unit_price,
    extract_unit_price,
    normalize_entry,
    parse_package_size,
    unit_price_disagreement,
)
from ingest.sources.loblaw import Product
from ingest.tests.conftest import product_entry


def api_entry(**overrides):
    """The exact shape the API returns."""
    entry = {
        "value": 1.56,
        "unit": "g",
        "quantity": 100,
        "reasonCode": None,
        "type": "REGULAR",
        "expiryDate": None,
    }
    entry.update(overrides)
    return entry


class TestExtractUnitPrice:
    def test_the_real_shape(self) -> None:
        """Triple Cheddar Shredded Cheese, $1.56/100g."""
        result = extract_unit_price([api_entry()])
        assert result is not None
        assert result.cents == 156
        assert result.unit == "g"
        assert result.quantity == Decimal(100)
        assert result.source == "api"

    def test_millilitres_and_each(self) -> None:
        """The only other two pairs the API was seen to use."""
        ml = extract_unit_price([api_entry(value=0.43, unit="ml", quantity=100)])
        assert ml is not None and (ml.cents, ml.unit, ml.quantity) == (43, "ml", 100)

        ea = extract_unit_price([api_entry(value=2.5, unit="ea", quantity=1)])
        assert ea is not None and (ea.cents, ea.unit, ea.quantity) == (250, "ea", 1)

    def test_an_empty_list_is_the_documented_common_case(self) -> None:
        assert extract_unit_price([]) is None

    def test_type_is_never_used_to_reject_an_entry(self) -> None:
        """ "REGULAR" appears on discounted items; the value tracks the sale price."""
        for label in ("REGULAR", "SALE", "PROMO", "", None):
            result = extract_unit_price([api_entry(type=label)])
            assert result is not None and result.cents == 156

    def test_the_first_entry_wins(self) -> None:
        """No product of 315 had more than one, but the field is a list."""
        result = extract_unit_price([api_entry(value=1.56), api_entry(value=9.99, unit="kg")])
        assert result is not None and result.cents == 156

    def test_a_big_unit_is_folded_onto_the_canonical_one(self) -> None:
        """$3.00/kg is $3.00 per 1000 g: the price holds, the quantity scales."""
        result = extract_unit_price([api_entry(value=3.00, unit="kg", quantity=1)])
        assert result is not None
        assert (result.cents, result.unit, result.quantity) == (300, "g", Decimal(1000))

    def test_an_unknown_unit_yields_nothing(self) -> None:
        assert extract_unit_price([api_entry(unit="sheet")]) is None

    @pytest.mark.parametrize("bad", [{"value": None}, {"quantity": 0}, {"quantity": None}])
    def test_unusable_entries_yield_nothing(self, bad) -> None:
        assert extract_unit_price([api_entry(**bad)]) is None

    def test_a_non_dict_entry_does_not_explode(self) -> None:
        assert extract_unit_price(["nonsense"]) is None


class TestParsePackageSize:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("500 g", (Decimal(500), "g")),
            ("200 g", (Decimal(200), "g")),
            ("454 g", (Decimal(454), "g")),
            ("500 ml", (Decimal(500), "ml")),
            ("1 ea", (Decimal(1), "ea")),
            ("30 ea", (Decimal(30), "ea")),
        ],
    )
    def test_the_common_forms(self, raw, expected) -> None:
        """Straight from the top of the products table."""
        assert parse_package_size(raw) == expected

    def test_litres_become_millilitres(self) -> None:
        """1,503 products are written in l. Without this they never compare."""
        assert parse_package_size("1 l") == (Decimal(1000), "ml")
        assert parse_package_size("2 l") == (Decimal(2000), "ml")
        value, unit = parse_package_size("1.89 l")
        assert unit == "ml" and value == Decimal(1890)

    def test_kilograms_become_grams(self) -> None:
        """1,212 products are written in kg."""
        assert parse_package_size("1 kg") == (Decimal(1000), "g")
        assert parse_package_size("2 kg") == (Decimal(2000), "g")

    def test_a_multipack_is_its_total(self) -> None:
        """ "12x355.0 ml" is 4260 ml, because the shelf price buys all twelve."""
        value, unit = parse_package_size("12x355.0 ml")
        assert unit == "ml" and value == Decimal(4260)

    def test_casing_and_spacing_drift(self) -> None:
        assert parse_package_size("4 L") == (Decimal(4000), "ml")
        assert parse_package_size("  500 G  ") == (Decimal(500), "g")

    @pytest.mark.parametrize("raw", ["16 m", "2 sh", "1 pk", "30 mm"])
    def test_units_outside_the_table_yield_nothing(self, raw) -> None:
        """m, sh, pk, mm: 23 rows between them. A guess is worse than a NULL."""
        assert parse_package_size(raw) is None

    @pytest.mark.parametrize(
        "raw", ["", "approx 450 g", "0.5 - 0.7 kg", "each", "500", "g", "500 g extra"]
    )
    def test_unparseable_strings_yield_nothing(self, raw) -> None:
        assert parse_package_size(raw) is None

    def test_zero_and_negative_sizes_are_refused(self) -> None:
        assert parse_package_size("0 g") is None
        assert parse_package_size("0x355 ml") is None


class TestDeriveUnitPrice:
    def test_it_matches_what_the_api_said(self) -> None:
        """Triple Cheddar: 320 g at $4.99. The API reported $1.56/100 g."""
        result = derive_unit_price(499, Decimal(320), "g")
        assert result is not None
        assert result.cents == 156
        assert (result.unit, result.quantity, result.source) == ("g", 100, "derived")

    def test_wheat_thins(self) -> None:
        """180 g at $2.00. The API reported $1.11/100 g."""
        result = derive_unit_price(200, Decimal(180), "g")
        assert result is not None and result.cents == 111

    def test_each_is_priced_per_one_not_per_hundred(self) -> None:
        result = derive_unit_price(600, Decimal(30), "ea")
        assert result is not None
        assert (result.cents, result.quantity) == (20, Decimal(1))

    def test_an_uncomparable_unit_yields_nothing(self) -> None:
        assert derive_unit_price(499, Decimal(320), "m") is None


class TestNormalizeEntry:
    def test_the_api_path_wins_when_available(self) -> None:
        row = normalize_entry(
            Product.model_validate(
                product_entry(
                    packageSize="320 g",
                    prices={"price": {"value": 4.99}, "comparisonPrices": [api_entry()]},
                )
            )
        )
        assert row is not None
        assert row.unit_price_source == "api"
        assert row.unit_price_cents == 156
        assert row.comparison_unit == "g"
        assert row.comparison_quantity == Decimal(100)

    def test_the_parser_fills_in_when_the_api_does_not(self) -> None:
        row = normalize_entry(
            Product.model_validate(
                product_entry(
                    packageSize="320 g",
                    prices={"price": {"value": 4.99}, "comparisonPrices": []},
                )
            )
        )
        assert row is not None
        assert row.unit_price_source == "derived"
        assert row.unit_price_cents == 156

    def test_size_is_parsed_even_when_the_api_supplies_a_unit_price(self) -> None:
        """size_value and size_unit are identity fields, not just parser output."""
        row = normalize_entry(
            Product.model_validate(
                product_entry(
                    packageSize="1 l",
                    prices={
                        "price": {"value": 3.00},
                        "comparisonPrices": [api_entry(value=0.30, unit="ml")],
                    },
                )
            )
        )
        assert row is not None
        assert row.unit_price_source == "api"
        assert (row.size_value, row.size_unit) == (Decimal(1000), "ml")

    def test_an_unparseable_size_and_no_api_price_leaves_a_null(self) -> None:
        row = normalize_entry(
            Product.model_validate(
                product_entry(
                    packageSize="16 m",
                    prices={"price": {"value": 4.99}, "comparisonPrices": []},
                )
            )
        )
        assert row is not None
        assert row.unit_price_source == "none"
        assert row.unit_price_cents is None
        assert row.price_cents == 499, "the observation is still stored"

    def test_a_sale_price_and_its_unit_price_stay_consistent(self) -> None:
        """The real trap: type says REGULAR but the value follows the sale price."""
        row = normalize_entry(
            Product.model_validate(
                product_entry(
                    packageSize="320 g",
                    prices={
                        "price": {"value": 4.99},
                        "wasPrice": {"value": 6.00, "unit": "ea", "type": "WAS"},
                        "comparisonPrices": [api_entry()],
                    },
                )
            )
        )
        assert row is not None
        assert (row.price_cents, row.was_price_cents) == (499, 600)
        assert row.on_sale is True
        assert unit_price_disagreement(row) == 0, "unit price must match the sale price"


class TestUnitPriceDisagreement:
    def test_agreement_reads_zero(self) -> None:
        row = normalize_entry(
            Product.model_validate(
                product_entry(
                    packageSize="320 g",
                    prices={"price": {"value": 4.99}, "comparisonPrices": [api_entry()]},
                )
            )
        )
        assert row is not None and unit_price_disagreement(row) == 0

    def test_a_mismatch_is_detected(self) -> None:
        """If the API ever starts quoting the pre-sale price, this fires."""
        row = normalize_entry(
            Product.model_validate(
                product_entry(
                    packageSize="320 g",
                    prices={
                        "price": {"value": 4.99},
                        "comparisonPrices": [api_entry(value=1.875)],
                    },
                )
            )
        )
        assert row is not None
        gap = unit_price_disagreement(row)
        assert gap is not None and gap > Decimal("0.15")

    def test_nothing_to_compare_reads_none(self) -> None:
        row = normalize_entry(
            Product.model_validate(
                product_entry(
                    packageSize="16 m",
                    prices={"price": {"value": 4.99}, "comparisonPrices": []},
                )
            )
        )
        assert row is not None and unit_price_disagreement(row) is None
