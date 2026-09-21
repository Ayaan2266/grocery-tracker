"""Tests for normalization.

This file doubles as the decision log for parse_package_size. The xfail cases
below are the decisions Ayaan has not made yet -- when he implements the
fallback parser, each xfail becomes a passing assertion and the reasoning is
already written down.
"""

import json
from pathlib import Path

import pytest

from ingest.models import SearchResponse
from ingest.normalize import is_on_sale, normalize, parse_package_size, to_cents

FIXTURE = Path(__file__).parent / "fixtures" / "search_nofrills_milk.json"


@pytest.fixture
def response() -> SearchResponse:
    return SearchResponse.model_validate(json.loads(FIXTURE.read_text()))


def test_unknown_upstream_fields_do_not_break_parsing(response):
    """The API is undocumented and adds fields without notice. A new field must
    never fail a nightly run."""
    assert len(response.results) == 3


def test_money_is_stored_as_integer_cents():
    assert to_cents(6.44) == 644
    assert to_cents(0.1) == 10
    assert to_cents(None) is None


def test_uses_api_comparison_price_when_present(response):
    milk = normalize(response.results[0])
    assert milk.price_cents == 644
    assert milk.unit_price_cents == 16
    assert milk.comparison_unit == "ml"
    assert milk.comparison_quantity == 100
    assert milk.unit_price_source == "api"


def test_was_price_is_the_only_sale_signal(response):
    regular = normalize(response.results[0])
    on_sale = normalize(response.results[1])
    assert regular.was_price_cents is None
    assert is_on_sale(regular) is False
    assert on_sale.was_price_cents == 718
    assert is_on_sale(on_sale) is True


def test_stock_status_is_parsed(response):
    assert normalize(response.results[0]).in_stock is True
    assert normalize(response.results[2]).in_stock is False


def test_row_survives_missing_comparison_price(response):
    """A product we cannot unit-price still produces a row. Dropping it would
    lose a day of price history that cannot be backfilled."""
    eggs = normalize(response.results[2])
    assert eggs.price_cents == 429
    assert eggs.unit_price_cents is None
    assert eggs.unit_price_source == "none"


class TestPackageSizeFallback:
    """Unimplemented by design. See ingest/normalize.py module docstring."""

    @pytest.mark.xfail(raises=NotImplementedError, reason="Ayaan implements the fallback parser")
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("4 l", (4000.0, "ml")),
            ("500g", (500.0, "g")),
            ("2 x 250 g", (500.0, "g")),  # decision: multipack totals
            ("12x355ml", (4260.0, "ml")),
        ],
    )
    def test_parses_sizes(self, raw, expected):
        assert parse_package_size(raw) == expected

    @pytest.mark.xfail(raises=NotImplementedError, reason="Ayaan decides count-unit handling")
    def test_count_units_have_no_mass(self):
        assert parse_package_size("12 ct") is None

    @pytest.mark.xfail(raises=NotImplementedError, reason="Ayaan decides approximate-weight policy")
    def test_approximate_weight_is_flagged_or_refused(self):
        assert parse_package_size("approx 1.2 kg") is None
