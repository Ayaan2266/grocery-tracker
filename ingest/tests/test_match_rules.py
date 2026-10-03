"""The rules in ingest/match.py that widen what a substitute key accepts.

test_match_quality.py scores the matcher against hand-labelled pairs. These pin
each rule on its own, both ways: what it now accepts, and the nearest thing it
must still refuse. A rule that loosens a key without a test for what stays
apart is how a wrong "similar" claim gets in.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from ingest.match import keys, propose_matches, size_bucket


def identity(brand: str | None, name: str, size: str) -> str | None:
    return keys(brand, name, size)[0]


def substitute(brand: str | None, name: str, size: str) -> str | None:
    return keys(brand, name, size)[1]


class TestSizeTolerance:
    def test_a_few_millilitres_apart_is_the_same_size(self) -> None:
        # Kikkoman is 148 ml, Lee Kum Kee 150 ml.
        assert size_bucket(Decimal(148), "ml") == size_bucket(Decimal(150), "ml")

    def test_a_unit_conversion_is_the_same_size(self) -> None:
        # 40 lb of rice is 18.144 kg; the other brand sells 18 kg.
        assert size_bucket(Decimal(18144), "g") == size_bucket(Decimal(18000), "g")
        assert size_bucket(Decimal(946), "ml") == size_bucket(Decimal(950), "ml")
        assert size_bucket(Decimal(454), "g") == size_bucket(Decimal(450), "g")

    @pytest.mark.parametrize(
        ("a", "b"),
        [
            (473, 500),  # a pint of cream is not half a litre of it
            (750, 740),
            (1890, 2000),  # half a US gallon against 2 l
            (355, 500),
            (4000, 3780),  # 4 l against a US gallon
            (100, 110),
        ],
    )
    def test_sizes_that_are_really_different_stay_apart(self, a: int, b: int) -> None:
        assert size_bucket(Decimal(a), "ml") != size_bucket(Decimal(b), "ml")

    def test_two_totals_that_agree_are_within_three_percent(self) -> None:
        """Both ends snap to the same two-figure number, each within 1.5% of it."""
        by_bucket: dict[str, list[int]] = {}
        for total in range(100, 20000):
            by_bucket.setdefault(size_bucket(Decimal(total), "g"), []).append(total)
        for members in by_bucket.values():
            assert max(members) / min(members) <= 1.0305, members

    def test_a_count_of_items_is_never_snapped(self) -> None:
        assert size_bucket(Decimal(148), "ea") != size_bucket(Decimal(150), "ea")

    def test_identity_still_needs_the_exact_package(self) -> None:
        assert identity("Kikkoman", "Less Sodium Soy Sauce", "148 ml") != identity(
            "Kikkoman", "Less Sodium Soy Sauce", "150 ml"
        )

    def test_the_pair_in_the_labelled_sample_now_matches(self) -> None:
        assert substitute("Lee Kum Kee", "Less Sodium Soy Sauce 150 ml", "150 ml") == substitute(
            "Kikkoman", "Less Sodium Soy Sauce", "148 ml"
        )

    def test_a_different_pack_count_is_still_a_different_product(self) -> None:
        assert substitute(None, "Cola", "6x355 ml") != substitute(None, "Cola", "12x355 ml")


class TestSoftWords:
    def test_original_and_classic_are_not_counted_for_a_substitute(self) -> None:
        assert substitute("Dare", "Holiday Crackers Original", "180 g") == substitute(
            "Christie", "Holiday Crackers", "180 g"
        )
        assert substitute("Aylmer", "Original Diced Tomatoes", "796 ml") == substitute(
            "No Name", "Diced Tomatoes", "796 ml"
        )
        assert substitute(None, "Classic Chicken Noodle Soup", "540 ml") == substitute(
            None, "Chicken Noodle Soup", "540 ml"
        )

    def test_another_flavour_word_still_separates_them(self) -> None:
        assert substitute(None, "Original Potato Chips", "235 g") != substitute(
            None, "Ketchup Potato Chips", "235 g"
        )
        assert substitute(None, "Original Potato Chips", "235 g") != substitute(
            None, "Salt and Vinegar Potato Chips", "235 g"
        )

    def test_an_identity_still_counts_them(self) -> None:
        """The same brand's "Original" and plain listing are not one product."""
        assert identity("Dare", "Crackers Original", "180 g") != identity(
            "Dare", "Crackers", "180 g"
        )

    def test_a_name_made_only_of_soft_words_keeps_them(self) -> None:
        assert substitute(None, "Original", "100 g") is not None


class TestSynonyms:
    def test_disinfecting_and_disinfectant_are_one_word(self) -> None:
        assert keys("No Name", "Fresh Scent Disinfectant Wipes", "75 ea") == keys(
            "No Name", "Fresh Scent Disinfecting Wipes", "75 ea"
        )
        assert substitute("No Name", "Fresh Scent Disinfectant Wipes", "75 ea") == substitute(
            "Clorox", "Wipes Disinfecting, Fresh Scent", "75 ea"
        )


class TestWeighedItems:
    def weighed(self, name: str, sku: str = "20001988_KG", brand: str | None = None):
        return keys(brand, name, "", retailer_sku=sku, comparison_unit="g")

    def test_a_weighed_item_gets_a_substitute_key_and_never_an_identity(self) -> None:
        identity_key, substitute_key = self.weighed("Lean Ground Beef, Club Pack")
        assert identity_key is None
        assert substitute_key == "weighed|beef ground lean|g"

    def test_the_same_cut_under_two_codes_agrees(self) -> None:
        assert self.weighed("Lean Ground Beef, Club Pack", "20001988_KG") == self.weighed(
            "Lean Ground Beef", "21724638_KG"
        )
        assert self.weighed("Pork Half Loin", "20554787_KG") == self.weighed(
            "Half Pork Loin", "21674108_KG"
        )

    def test_a_different_cut_or_variant_does_not(self) -> None:
        lean = self.weighed("Lean Ground Beef")[1]
        assert lean != self.weighed("Extra Lean Ground Beef")[1]
        assert lean != self.weighed("Medium Ground Beef")[1]
        assert lean != self.weighed("Kosher Lean Ground Beef")[1]
        assert lean != self.weighed("Lean Ground Beef & Pork")[1]

    def test_an_organic_brand_is_not_the_conventional_item(self) -> None:
        plain = self.weighed("Tomato On The Vine Red (1 Bunch)")[1]
        organic = self.weighed("Tomato On The Vine Red (1 Bunch)", brand="PC Organics")[1]
        assert plain != organic

    def test_a_weight_in_the_name_is_not_a_difference(self) -> None:
        assert (
            self.weighed("Frozen Grade A Turkey 9-11 kg")[1]
            == self.weighed("Grade A Frozen Turkey, 9-11 kg")[1]
        )

    def test_it_needs_the_weighed_code_and_a_unit_price_by_weight(self) -> None:
        nothing = (None, None)
        assert keys(None, "Steak", "", retailer_sku="STEAK_EA", comparison_unit="g") == nothing
        assert keys(None, "Steak", "", retailer_sku="STEAK_KG", comparison_unit=None) == nothing
        assert keys(None, "Steak", "", retailer_sku="STEAK_KG", comparison_unit="ea") == nothing
        assert keys(None, "Steak", None) == nothing

    def test_a_weighed_key_cannot_equal_a_packaged_one(self) -> None:
        packaged = substitute(None, "Lean Ground Beef", "500 g")
        assert self.weighed("Lean Ground Beef")[1] != packaged

    def test_a_packaged_item_with_a_weighed_code_keeps_its_package_keys(self) -> None:
        got = keys(None, "Lean Ground Beef", "500 g", retailer_sku="X_KG", comparison_unit="g")
        assert got == keys(None, "Lean Ground Beef", "500 g")
        assert got[0] is not None

    def product(self, id: int, store_id: int, sku: str, name: str) -> dict:
        return {
            "id": id,
            "store_id": store_id,
            "retailer_sku": sku,
            "brand": None,
            "raw_name": name,
            "package_size": "",
            "comparison_unit": "g",
        }

    def test_two_stores_codes_pair_as_substitutes_not_identities(self) -> None:
        pairs = propose_matches(
            [
                self.product(1, 1, "A_KG", "Pork Tenderloin"),
                self.product(2, 2, "B_KG", "Pork Tenderloin"),
            ]
        )
        assert [(p.left_product_id, p.right_product_id, p.basis) for p in pairs] == [
            (1, 2, "substitute")
        ]

    def test_one_code_at_two_stores_is_left_to_the_code(self) -> None:
        pairs = propose_matches(
            [
                self.product(1, 1, "A_KG", "Pork Tenderloin"),
                self.product(2, 2, "A_KG", "Pork Tenderloin"),
            ]
        )
        assert pairs == []

    def test_no_identity_key_is_not_an_equal_identity_key(self) -> None:
        """Two listings that both lack an identity key are not the same item."""
        pairs = propose_matches(
            [
                self.product(1, 1, "A_KG", "Pork Tenderloin"),
                self.product(2, 2, "B_KG", "Pork Tenderloin"),
                self.product(3, 3, "C_KG", "Pork Tenderloin"),
            ]
        )
        assert pairs
        assert {p.basis for p in pairs} == {"substitute"}
