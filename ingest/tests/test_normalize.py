"""Normalization tests.

The unit-price stubs are intentionally unimplemented, so the assertions here
cover the mechanical half and pin the *current* documented behaviour: a NULL
unit price with source "none". When extract_unit_price lands, the test named
below is the one that changes.
"""

from __future__ import annotations

from ingest.money import dollars_to_cents
from ingest.normalize import extract_image_url, normalize_entry
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

    def test_a_compound_unit_string_falls_through_to_the_parser(self) -> None:
        """The API uses unit="ml" with quantity=100, never a compound "100ml".

        If it ever did, the unit table would reject it and the derived path
        takes over rather than storing something unjoinable. $6.44 for 4 L is
        16 cents per 100 ml.
        """
        row = parse(
            prices={
                "price": {"value": 6.44},
                "comparisonPrices": [{"value": 0.16, "unit": "100ml", "quantity": 1}],
            }
        )
        assert row is not None
        assert row.unit_price_source == "derived"
        assert row.unit_price_cents == 16
        assert row.comparison_unit == "ml"


def photo(n: int) -> dict[str, str | None]:
    """One imageAssets entry as the live API sent it on 2026-10-21."""
    base = f"https://digital.loblaws.ca/PCX/21425018_EA/en/{n}/21425018_en_{n}"
    return {
        "imageUrl": None,
        "thumbnailUrl": f"{base}_120.png",
        "smallUrl": f"{base}_250.png",
        "mediumUrl": f"{base}_400.png",
        "largeUrl": f"{base}_800.png",
        "extraLargeUrl": f"{base}_1200.png",
        "smallRetinaUrl": None,
        "mediumRetinaUrl": None,
        "largeRetinaUrl": None,
    }


class TestImageUrl:
    def test_keeps_the_first_photo_at_400_px(self) -> None:
        assert (
            extract_image_url([photo(1), photo(2)])
            == "https://digital.loblaws.ca/PCX/21425018_EA/en/1/21425018_en_1_400.png"
        )

    def test_falls_back_to_another_size_of_the_same_photo(self) -> None:
        first = {**photo(1), "mediumUrl": None}
        assert extract_image_url([first, photo(2)]) == first["largeUrl"]

    def test_moves_on_to_the_next_photo_when_one_has_no_link(self) -> None:
        empty = dict.fromkeys(photo(1))
        assert extract_image_url([empty, photo(2)]) == photo(2)["mediumUrl"]

    def test_no_photos_is_no_link(self) -> None:
        assert extract_image_url(None) is None
        assert extract_image_url([]) is None

    def test_only_an_https_link_is_kept(self) -> None:
        """It goes straight into an <img> on the site."""
        assert extract_image_url([{"mediumUrl": "javascript:alert(1)"}]) is None
        assert extract_image_url([{"mediumUrl": "http://digital.loblaws.ca/a_400.png"}]) is None
        assert extract_image_url([{"mediumUrl": "//digital.loblaws.ca/a_400.png"}]) is None

    def test_an_unexpected_shape_is_skipped_not_fatal(self) -> None:
        assert extract_image_url("https://digital.loblaws.ca/a_400.png") is None
        assert extract_image_url({"mediumUrl": "https://digital.loblaws.ca/a_400.png"}) is None
        assert extract_image_url(["https://x", 7, {"mediumUrl": 7}]) is None

    def test_normalize_entry_carries_the_link(self) -> None:
        row = parse(imageAssets=[photo(1)])
        assert row is not None
        assert row.image_url == photo(1)["mediumUrl"]

    def test_a_product_without_imageassets_still_parses(self) -> None:
        row = parse()
        assert row is not None
        assert row.image_url is None

    def test_malformed_imageassets_never_fail_the_product(self) -> None:
        row = parse(imageAssets="not a list")
        assert row is not None
        assert row.price_cents == 644
        assert row.image_url is None
