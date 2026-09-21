"""Cross-banner product matching.

This is the hard problem in the project and the thing interviewers will ask
about. It is intentionally a skeleton: the file is empty of logic because the
logic is the deliverable, and because the spec says not to design matching
before week 3, when there is real messy data to look at.

## The problem

There is no shared identifier across banners. `code` ("20188873_EA") is a
retailer SKU, unique to Loblaw's catalogue, and does not survive a jump to
Metro or Sobeys. There is no UPC in the response. So matching has to run on:

    brand + name + package size + category

and those three products are the same thing:

    "Neilson 2% Partly Skimmed Milk, 4 L"        nofrills   4 l
    "Beatrice 2% Milk 4L"                         superstore 4 l
    "No Name 2% Partly Skimmed Milk 4 Litre"      loblaw     4 l

...except they are not. Neilson and Beatrice are different products at the
same size. Whether they belong in one "match group" depends on the question:

  * "Is today's 4L Neilson cheaper than usual?"  -> same brand, same size.
    Strict identity.
  * "What is the cheapest 4L of 2% milk near me?" -> substitutable group.
    Brand-agnostic.

These are two different relations and collapsing them into one table is the
mistake that will make the basket feature produce nonsense. Decide whether
`product_matches` stores identity, substitutability, or both with a type
column, before you write a line of scoring.

## Approaches, cheapest first

1. Deterministic key: normalized brand + size value + size unit + category.
   Catches the easy majority. Fast, explainable, no dependencies, and you can
   defend every decision it makes in an interview. Start here.
2. Fuzzy string similarity on the normalized name (rapidfuzz token_set_ratio)
   with a threshold, used only to propose candidates that 1 missed.
3. Embeddings. Only if 1 and 2 leave a category that clearly needs it. Adds a
   model dependency and an unexplainable failure mode to a project whose
   selling point is that it is defensible.

## What actually matters for the write-up

Precision over recall. A wrong match produces a false "this is cheaper at
Superstore" claim, which is worse than no claim. Hold out ~100 hand-labelled
pairs from real ingested data and report precision/recall on them in the
README's "What doesn't work yet" section. Almost nobody does this, and it is
the difference between "I built a matcher" and "I measured my matcher".
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class MatchType(StrEnum):
    """Two different relations. Do not conflate them."""

    IDENTITY = "identity"  # same manufacturer product, different banner listing
    SUBSTITUTE = "substitute"  # different brand, interchangeable for a basket


@dataclass(frozen=True)
class MatchCandidate:
    left_product_id: int
    right_product_id: int
    match_type: MatchType
    confidence: float  # 0..1
    reason: str  # human-readable -- goes in the review UI and the write-up


def normalize_name(raw_name: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace, drop size tokens that
    are already captured structurally. Deliberately unimplemented."""
    raise NotImplementedError


def deterministic_key(brand: str | None, size_value: float | None, size_unit: str | None) -> str:
    """Approach 1. Build the exact-match key. Deliberately unimplemented."""
    raise NotImplementedError


def propose_matches(products: list[object]) -> list[MatchCandidate]:
    """Return candidate links for human review. Never write directly to
    `product_matches` from here -- an unreviewed matcher silently poisons every
    downstream price comparison. Deliberately unimplemented."""
    raise NotImplementedError
