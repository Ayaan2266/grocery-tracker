"""How good the matcher is, measured on hand-labelled real listings.

fixtures/labelled_pairs.json holds pairs of listings from the catalogue as
sampled on 2026-09-25, each labelled identity, substitute or different by
hand. This scores ingest/match.py against them, so precision and recall are
numbers rather than a feeling, and a rule change that makes them worse fails
here before it pairs the wrong products in production.

Precision is what the thresholds guard. A wrong identity puts a different
product into a "same item" comparison and a basket total; a wrong substitute
shows an unfair alternative. A missed pair shows nothing, which is why recall
is reported but only guarded against collapse.

    pytest ingest/tests/test_match_quality.py -s    # prints the numbers
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pytest

from ingest.match import keys

FIXTURE = Path(__file__).parent / "fixtures" / "labelled_pairs.json"
PAIRS = json.loads(FIXTURE.read_text(encoding="utf-8"))["pairs"]


def predict(pair: dict) -> str:
    left = keys(pair["left"]["brand"], pair["left"]["name"], pair["left"]["package_size"])
    right = keys(pair["right"]["brand"], pair["right"]["name"], pair["right"]["package_size"])
    # The catalogue had two SKUs under this identity key at one store, which
    # the matcher never treats as an identity (see match.ambiguous_identity_keys).
    if left[0] is not None and left[0] == right[0] and not pair.get("ambiguous_identity"):
        return "identity"
    if left[1] is not None and left[1] == right[1]:
        return "substitute"
    return "different"


def score(pairs: list[dict]) -> dict[str, float | int | None]:
    """Precision and recall; None where nothing was predicted or labelled."""
    outcomes = Counter((pair["label"], predict(pair)) for pair in pairs)

    def total(label: str | None = None, prediction: str | None = None) -> int:
        return sum(
            n
            for (lab, pred), n in outcomes.items()
            if label in (None, lab) and prediction in (None, pred)
        )

    def ratio(hits: int, out_of: int) -> float | None:
        return hits / out_of if out_of else None

    labelled_match = total() - total(label="different")
    return {
        "pairs": len(pairs),
        "identity_precision": ratio(
            outcomes[("identity", "identity")], total(prediction="identity")
        ),
        "identity_recall": ratio(outcomes[("identity", "identity")], total(label="identity")),
        # A substitute claim about a pair that is really identical is true, if weak.
        "substitute_precision": ratio(
            outcomes[("substitute", "substitute")] + outcomes[("identity", "substitute")],
            total(prediction="substitute"),
        ),
        "match_recall": ratio(
            labelled_match - total("identity", "different") - total("substitute", "different"),
            labelled_match,
        ),
        "predicted_identity": total(prediction="identity"),
        "predicted_substitute": total(prediction="substitute"),
    }


def test_the_fixture_is_well_formed() -> None:
    assert len(PAIRS) >= 200
    for pair in PAIRS:
        assert pair["label"] in {"identity", "substitute", "different"}
        assert pair["source"] in {"neighbour", "proposal", "hard case"}
        assert set(pair) <= {"source", "label", "left", "right", "note", "ambiguous_identity"}
        for side in ("left", "right"):
            assert set(pair[side]) == {"brand", "name", "package_size"}


def test_no_identity_is_wrong() -> None:
    """A wrong identity is a false "same item" and a wrong basket total."""
    wrong = [p for p in PAIRS if predict(p) == "identity" and p["label"] != "identity"]
    assert wrong == []


def test_substitutes_are_almost_never_wrong() -> None:
    assert score(PAIRS)["substitute_precision"] >= 0.97


@pytest.mark.parametrize("source", ["neighbour", "hard case"])
def test_nothing_the_matcher_did_not_choose_is_mismatched(source: str) -> None:
    """On pairs picked without the matcher's help, every claim it makes is right."""
    subset = [p for p in PAIRS if p["source"] == source]
    wrong = [
        (p["left"]["name"], p["right"]["name"], p["label"], predict(p))
        for p in subset
        if predict(p) != "different"
        and not (p["label"] == predict(p) or (p["label"], predict(p)) == ("identity", "substitute"))
    ]
    assert wrong == []


def test_recall_has_not_collapsed() -> None:
    """Missing a pair shows nothing rather than something wrong, so recall is
    traded for precision on purpose. It is still watched: on the neighbour
    pairs, which the matcher had no part in choosing, it found 14 of 22."""
    neighbours = score([p for p in PAIRS if p["source"] == "neighbour"])
    assert neighbours["match_recall"] >= 0.6


def test_print_the_numbers(capsys: pytest.CaptureFixture[str]) -> None:
    with capsys.disabled():
        for source in ("neighbour", "proposal", "hard case", None):
            subset = [p for p in PAIRS if source is None or p["source"] == source]
            numbers = score(subset)
            print(
                f"\n{source or 'all':<10} "
                + "  ".join(
                    f"{k}={v:.2f}" if isinstance(v, float) else f"{k}={'-' if v is None else v}"
                    for k, v in numbers.items()
                )
            )
