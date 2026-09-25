"""Cross-store product matching.

All three banners run on the same PCX platform, so the same product usually
carries the same SKU at every store that stocks it, and the frontend already
pairs listings by SKU. Two gaps remain, both measured on the catalogue sampled
on 2026-09-25 (db/queries/catalogue_sample.sql):

IDENTITY the SKU misses. The same manufactured good under a different code at
    one banner: No Name 100% Pure Canola Oil 946 ml is 20088990_EA at No Frills
    and Loblaws and 21594669_EA at Superstore; President's Choice "Gigantico
    Burger Buns" is "Burger Buns Gigantico" at Superstore, 8x71 g at both.
    Comparing these is always fair, so they may count as the same item.

SUBSTITUTABILITY. Different goods a shopper would accept for each other:
    Neilson "2% Milk" 4 l, stocked at No Frills and Loblaws, against Beatrice
    "Partly Skimmed Milk 2%" 4 l, which is what Superstore carries instead.
    These make "where is this cheapest" answerable across banners that stock
    different brands, and are also where a wrong call does real damage, so a
    substitute is never presented as the same item and never priced into a
    basket as one.

Both are exact keys, not a similarity score. The sample is why: on a name
similarity score, the pairs that must stay apart score as high as the ones that
belong together. "Condensed Soup Yellow Thai Curry" against "Condensed Soup
Tomato" is 0.42, "2% Milk" against "Partly Skimmed Milk 2%" is lower, and M&M's
Mini against Peanut is 0.77. Nearly every wrong neighbour differed from its
product by one discriminating word -- a flavour, "Organic", "Microfiltered",
"Lactose Free", "Brown" -- and nearly every right one differed only in word
order, plurals, punctuation, or words that restate the package. So a name is
reduced to the set of words that describe the product, and two names agree
only when those sets are equal. That trades recall for precision on purpose:
a missed pairing shows no comparison, a wrong one shows a false one.

  identity_key    brand + name words + the exact package (pack count, total,
                  unit). 6x710 ml and 12x355 ml Pepsi are not one product.
  substitute_key  name words + pack count + the total to three significant
                  figures, so 2.268 kg and 2.27 kg (5 lb either way) agree.

A key is only evidence where it is unambiguous. Heinz Tomato Ketchup 750 ml has
two SKUs at the same No Frills at different prices, so its identity key cannot
say which of them another store's listing is. Consumers must treat an identity
key held by two SKUs at any one store as no match at all; `propose_matches`
does, and so does the frontend.

Weighed items (the _KG SKUs, ~800 products with no package size) get no keys:
their price is per weight and nothing says how the stores weigh them.

Precision and recall against hand-labelled pairs from the same sample are
measured in ingest/tests/test_match_quality.py.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from itertools import combinations
from typing import Any, Literal

from dotenv import load_dotenv

from ingest.normalize import parse_package

Basis = Literal["identity", "substitute"]

# Words that carry no product meaning. Taken from the most frequent tokens in
# the sample, keeping anything that separates one product from another: "no"
# ("No Salt Added"), "free" ("Lactose Free"), "original" and "classic"
# (flavours, as often as not) all stay.
STOPWORDS = frozenset({"a", "an", "and", "by", "for", "in", "of", "the", "with"})

# Words that restate the package rather than describe the product. Every one
# of these separated a right pair in the sample: "Large Size Eggs 12 Pack"
# against "Eggs, Large", "Organic Milk 3.25% Jug" against "3.25% Organic Milk",
# "100% Whole Wheat English Muffins" against "Whole Wheat English Muffins".
# The size itself is compared through the package, not the name.
PACKAGING_WORDS = frozenset({"100%", "bag", "club", "count", "ct", "family", "jug", "pack", "size"})

# A size or count written into the name: "150 ml", "2 lb bag", "95mL",
# "12 Pack", "2x1.25 l". Removed so a name that states its size agrees with
# one that does not.
_SIZE_IN_NAME = re.compile(
    r"\b\d+(?:\.\d+)?\s*(?:x\s*\d+(?:\.\d+)?\s*)?"
    r"(?:g|kg|mg|ml|l|lb|lbs|oz|litres?|liters?)\b"
)
_COUNT_IN_NAME = re.compile(r"\b\d+\s*(?:pack|pk|count|ct|pcs)\b")
# Milk fat, "M.F.", restates the percentage beside it.
_MILK_FAT = re.compile(r"\bm\.?\s*f\b\.?")
# "Partly Skimmed Milk 2%" is Canadian labelling for 2% milk. Only dropped
# when a percentage says the same thing.
_PARTLY_SKIMMED = re.compile(r"\bpartly[\s-]+skimmed\b")
_PERCENT = re.compile(r"(\d)\s+%")
_POSSESSIVE = re.compile(r"['’]s\b")
_TOKEN_SPLIT = re.compile(r"[^a-z0-9%.]+")


@dataclass(frozen=True)
class MatchCandidate:
    """A proposed pairing of two listings at different stores.

    `basis` is never optional downstream: an identity may be compared as the
    same item, a substitute only ever as an alternative to it.
    """

    left_product_id: int
    right_product_id: int
    basis: Basis
    key: str


def _fold(text: str) -> str:
    """Lowercase, accents off: "PūrFiltre" and "Nestlé" become plain ASCII."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower()


def singular(token: str) -> str:
    """Fold plurals so singular and plural forms agree.

    Not English morphology, only consistency: "berries" and "berry" both
    become "berry", "cookies" and "cookie" both become "cooky". The result
    only has to be equal for equal words, not to be a word.
    """
    if len(token) <= 3 or not token.isalpha():
        return token
    if token.endswith(("ches", "shes", "sses", "xes", "zes")):
        token = token[:-2]
    elif token.endswith("s") and not token.endswith(("ss", "us", "is")):
        token = token[:-1]
    if token.endswith("ie"):
        token = token[:-2] + "y"
    elif token.endswith("oe") and len(token) > 4:
        token = token[:-1]
    return token


def brand_key(brand: str | None) -> str:
    """ "President's Choice" -> "presidentschoice". Empty when there is none."""
    if not brand:
        return ""
    return re.sub(r"[^a-z0-9]", "", _fold(brand))


def name_tokens(raw_name: str, brand: str | None = None) -> frozenset[str]:
    """The words of a product name that describe the product."""
    text = _fold(raw_name)
    text = text.replace("&", " and ").replace("+", " and ")
    text = _POSSESSIVE.sub("", text).replace("'", "").replace("’", "")
    text = _PERCENT.sub(r"\1%", text)
    text = _SIZE_IN_NAME.sub(" ", text)
    text = _COUNT_IN_NAME.sub(" ", text)
    text = _MILK_FAT.sub(" ", text)
    if "%" in text:
        text = _PARTLY_SKIMMED.sub(" ", text)

    tokens = set()
    for raw in _TOKEN_SPLIT.split(text):
        token = singular(raw.strip("."))
        if token and token not in STOPWORDS and token not in PACKAGING_WORDS:
            tokens.add(token)

    # An organic brand does not repeat the word: Organic Meadow's 4 l "Milk, 2%"
    # is organic milk, and must not pair with Neilson's conventional "2% Milk".
    if "organic" in brand_key(brand):
        tokens.add("organic")
    return frozenset(tokens)


def _plain(value: Decimal) -> str:
    """4260.0 -> "4260", 1.25 -> "1.25": one spelling per quantity."""
    return format(value.normalize(), "f")


def _significant(value: Decimal, digits: int = 3) -> str:
    """A total to three significant figures: 2268 -> "2270", 18144 -> "18100"."""
    if value == 0:
        return "0"
    exponent = value.adjusted() - digits + 1
    scaled = value.scaleb(-exponent).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    return _plain(scaled.scaleb(exponent))


def keys(
    brand: str | None, raw_name: str, package_size: str | None
) -> tuple[str | None, str | None]:
    """(identity_key, substitute_key) for one listing, or (None, None).

    None whenever the package does not parse or the name has no describing
    words: a key built on missing evidence would match everything else that is
    missing it.
    """
    package = parse_package(package_size) if package_size else None
    if package is None:
        return None, None
    words = name_tokens(raw_name, brand)
    if not words:
        return None, None

    name = " ".join(sorted(words))
    count = _plain(package.count)
    identity = f"{brand_key(brand)}|{name}|{count}|{_plain(package.total)}{package.unit}"
    substitute = f"{name}|{count}|{_significant(package.total)}{package.unit}"
    return identity, substitute


def ambiguous_identity_keys(products: list[dict[str, Any]]) -> set[str]:
    """Identity keys held by more than one SKU at some store."""
    skus: dict[tuple[str, Any], set[str]] = defaultdict(set)
    for product in products:
        key = product.get("identity_key")
        if key:
            skus[(key, product["store_id"])].add(product["retailer_sku"])
    return {key for (key, _store), found in skus.items() if len(found) > 1}


def with_keys(products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Copies of the products with identity_key and substitute_key filled in."""
    keyed = []
    for product in products:
        identity, substitute = keys(
            product.get("brand"), product["raw_name"], product.get("package_size")
        )
        keyed.append({**product, "identity_key": identity, "substitute_key": substitute})
    return keyed


def propose_matches(products: list[dict[str, Any]]) -> list[MatchCandidate]:
    """Every cross-store pairing the keys support, beyond a shared SKU.

    `products` are dicts with id, store_id, retailer_sku, brand, raw_name and
    package_size. Listings that already share a SKU are not proposed: the
    frontend pairs those already. A pair is proposed as an identity when the
    identity key is unambiguous, otherwise as a substitute when the
    substitute keys agree.
    """
    keyed = with_keys(products)
    ambiguous = ambiguous_identity_keys(keyed)

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for product in keyed:
        if product["substitute_key"]:
            groups[product["substitute_key"]].append(product)

    candidates = []
    for key, members in groups.items():
        for left, right in combinations(sorted(members, key=lambda p: p["id"]), 2):
            if left["store_id"] == right["store_id"]:
                continue
            if left["retailer_sku"] == right["retailer_sku"]:
                continue
            same = (
                left["identity_key"] == right["identity_key"]
                and left["identity_key"] not in ambiguous
            )
            candidates.append(
                MatchCandidate(
                    left_product_id=left["id"],
                    right_product_id=right["id"],
                    basis="identity" if same else "substitute",
                    key=left["identity_key"] if same else key,
                )
            )
    return candidates


# ---------------------------------------------------------------------------
# python -m ingest.match report
# ---------------------------------------------------------------------------

REPORT_QUERY = """
SELECT l.product_id AS id, l.store_id, l.banner_slug, l.retailer_sku, l.brand,
       l.raw_name, l.package_size, l.price_cents
  FROM product_latest_price l
"""


def _sample(items: list[Any], limit: int, key: Any) -> list[Any]:
    """A fixed pseudo-random sample, so two runs over the same data agree."""
    ranked = sorted(items, key=lambda item: hashlib.md5(key(item).encode()).hexdigest())
    return ranked[:limit]


def _describe(product: dict[str, Any]) -> str:
    price = f"${product['price_cents'] / 100:.2f}" if product.get("price_cents") else "-"
    return (
        f"{product['banner_slug']} {product['retailer_sku']} | {product.get('brand') or '-'} | "
        f"{product['raw_name'].strip()} | {product.get('package_size') or '-'} | {price}"
    )


def report(products: list[dict[str, Any]], *, limit: int = 120) -> None:
    """What the keys would pair across the catalogue. Prints; writes nothing."""
    keyed = with_keys(products)
    by_id = {product["id"]: product for product in keyed}
    ambiguous = ambiguous_identity_keys(keyed)
    candidates = propose_matches(products)
    identities = [c for c in candidates if c.basis == "identity"]
    substitutes = [c for c in candidates if c.basis == "substitute"]
    gaining = {c.left_product_id for c in identities} | {c.right_product_id for c in identities}

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for product in keyed:
        if product["substitute_key"]:
            groups[product["substitute_key"]].append(product)
    cross_store = {
        key: members
        for key, members in groups.items()
        if len({m["store_id"] for m in members}) > 1
        and len({m["retailer_sku"] for m in members}) > 1
    }

    print(f"products                          {len(keyed)}")
    print(f"  with keys                       {sum(1 for p in keyed if p['identity_key'])}")
    print(f"identity keys held by 2+ SKUs     {len(ambiguous)}  (never an identity)")
    print(f"identity pairs beyond the SKU     {len(identities)}")
    print(f"  listings gaining one            {len(gaining)}")
    print(f"substitute pairs                  {len(substitutes)}")
    print(f"substitute groups across stores   {len(cross_store)}")

    def pair_key(c: MatchCandidate) -> str:
        return f"{c.left_product_id}-{c.right_product_id}"

    print(f"\n== identity pairs (up to {limit})")
    for c in _sample(identities, limit, key=pair_key):
        print(f"{_describe(by_id[c.left_product_id])}\n  = {_describe(by_id[c.right_product_id])}")

    print(f"\n== substitute pairs (up to {limit})")
    for c in _sample(substitutes, limit, key=pair_key):
        print(f"{_describe(by_id[c.left_product_id])}\n  ~ {_describe(by_id[c.right_product_id])}")

    print("\n== the 25 largest substitute groups across stores")
    largest = sorted(cross_store.items(), key=lambda item: -len(item[1]))[:25]
    for key, members in largest:
        brands = sorted({m.get("brand") or "-" for m in members})
        print(f"{len(members):>4}  {key}  [{', '.join(brands)[:120]}]")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ingest.match", description=__doc__)
    parser.add_argument("command", choices=["report"])
    parser.add_argument("--limit", type=int, default=120, help="Pairs to print per basis.")
    args = parser.parse_args(argv)

    load_dotenv()
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        print("DATABASE_URL is not set.", file=sys.stderr)
        return 1

    # Imported here so the matching rules can be used without a database driver.
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, prepare_threshold=None, row_factory=dict_row) as conn:
        # Read-only at the server, not only by convention: this runs as the owner.
        conn.read_only = True
        products = conn.execute(REPORT_QUERY).fetchall()

    report(products, limit=args.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
