"""Cross-banner product matching.

This module PROPOSES candidates. It never writes to `product_matches`.

An unreviewed matcher silently poisons every downstream price comparison, and
a confidently wrong "cheaper at Superstore" claim is worse than no claim at
all -- it is the kind of bug a user only notices after trusting you once.

Deliberately unimplemented until there is real messy data to look at. Designing
a matcher against imagined product names is how you end up with rules that fit
nothing. Run the ingest for a week or two first, then read a few hundred real
names side by side and let the rules fall out of what you see.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MatchCandidate:
    """A proposed identity between two products at different stores."""

    left_product_id: int
    right_product_id: int
    confidence: float
    basis: str


def propose_matches(products: list[dict]) -> list[MatchCandidate]:
    """YOURS TO WRITE. Propose candidate matches for human review.

    The distinction that has to be settled before any code gets written:

    IDENTITY -- the same manufactured good with the same SKU-level identity,
    sold at two banners. Neilson 2% 4L at No Frills is Neilson 2% 4L at
    Loblaws. Comparing these is always fair, and this is what the basket
    optimizer needs.

    SUBSTITUTABILITY -- different goods a shopper would accept for each other.
    Neilson 2% 4L versus Beatrice 2% 4L. Comparing these is what makes the
    "cheapest basket" answer *useful*, because banners deliberately carry
    different house brands, and it is also where a wrong call does real damage:
    No Name versus President's Choice versus a national brand are not the same
    product and a shopper may care a lot which one they get.

    Conflating the two is the single easiest way to produce a confidently wrong
    price comparison. Two different tables, or at minimum a `basis` column that
    is never ignored downstream.

    Signals available, roughly in order of trustworthiness:
      - brand + size_value + size_unit exact agreement (strong, and cheap)
      - normalized name token overlap (medium, needs a stopword list built from
        real names -- "PC", "No Name", "Organic", pack counts)
      - unit price proximity (weak on its own; useful only as a tiebreak, and
        note it is NULL for everything until extract_unit_price exists)

    Do not skip measurement. Hand-label a few dozen pairs first and keep them
    as a fixture, so precision and recall are numbers you can quote rather than
    a feeling. That labelled set is also exactly what the README currently
    admits is missing.
    """
    return []
