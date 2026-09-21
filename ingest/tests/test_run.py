"""Run-loop tests. No network, no database -- the client is stubbed."""

from __future__ import annotations

from datetime import date

import pytest

from ingest.run import StoreTarget, ingest_store
from ingest.sources.loblaw import AccessDenied, SearchResponse, StoreVerificationError
from ingest.tests.conftest import product_entry, search_payload

TARGET = StoreTarget(banner="nofrills", store_code="3131", label="No Frills - Vaughan")
TODAY = date(2026, 9, 21)


class StubClient:
    """Returns a canned response per term and records what was asked for."""

    def __init__(self, per_term: dict[str, list[dict]], *, canary_ok: bool = True) -> None:
        self._per_term = per_term
        self._canary_ok = canary_ok
        self.searched: list[str] = []
        self.verified = False

    def verify_store(self, banner, store_id, *, terms=(), on_date=None):
        self.verified = True
        if not self._canary_ok:
            raise StoreVerificationError("canary came back empty")
        return 1

    def search(self, banner, store_id, term, *, page_size=48, on_date=None):
        self.searched.append(term)
        results = self._per_term.get(term, [])
        return SearchResponse.model_validate(search_payload(results))


def test_canary_runs_before_any_search() -> None:
    client = StubClient({"milk": [product_entry()]}, canary_ok=False)

    outcome = ingest_store(client, TARGET, ["milk"], ("milk",), TODAY)

    assert client.verified is True
    assert client.searched == [], "no term should be fetched from an unverified store"
    assert outcome.ok is False
    assert outcome.error is not None


def test_same_sku_under_several_terms_collapses_to_one_observation() -> None:
    """The schema allows one observation per product per day; collapse here."""
    milk = product_entry(code="20188873_EA")
    client = StubClient({"milk": [milk], "2% milk 4l": [milk], "dairy": [milk]})

    outcome = ingest_store(client, TARGET, ["milk", "2% milk 4l", "dairy"], ("milk",), TODAY)

    assert outcome.fetched == 3
    assert outcome.normalized == 1
    assert outcome.rows[0].retailer_sku == "20188873_EA"


def test_distinct_skus_are_all_kept() -> None:
    client = StubClient(
        {
            "milk": [product_entry(code="A_EA"), product_entry(code="B_EA")],
            "bread": [product_entry(code="C_EA")],
        }
    )

    outcome = ingest_store(client, TARGET, ["milk", "bread"], ("milk",), TODAY)

    assert outcome.normalized == 3
    assert {row.retailer_sku for row in outcome.rows} == {"A_EA", "B_EA", "C_EA"}


def test_entries_without_a_price_are_counted_not_silently_dropped() -> None:
    client = StubClient(
        {
            "milk": [
                product_entry(code="A_EA"),
                product_entry(code="B_EA", prices=None),
            ]
        }
    )

    outcome = ingest_store(client, TARGET, ["milk"], ("milk",), TODAY)

    assert outcome.normalized == 1
    assert outcome.skipped_no_price == 1


def test_sale_items_are_counted() -> None:
    client = StubClient(
        {
            "milk": [
                product_entry(
                    code="A_EA", prices={"price": {"value": 4.99}, "wasPrice": {"value": 6.44}}
                ),
                product_entry(code="B_EA"),
            ]
        }
    )

    outcome = ingest_store(client, TARGET, ["milk"], ("milk",), TODAY)

    assert outcome.on_sale == 1
    assert outcome.normalized == 2


class DenyingClient(StubClient):
    """Canary passes, then the API returns a stop signal on a search term."""

    def search(self, banner, store_id, term, *, page_size=48, on_date=None):
        self.searched.append(term)
        raise AccessDenied("stop signal", status_code=403)


def test_stop_signal_aborts_the_run_rather_than_becoming_a_store_error() -> None:
    """AccessDenied subclasses IngestError, so the term loop must re-raise it.

    Swallowing it would record a per-store failure and move on to the next
    store -- continuing to hit an API that has just told us to stop, and
    exiting 1 instead of 2.
    """
    client = DenyingClient({"milk": []})

    with pytest.raises(AccessDenied):
        ingest_store(client, TARGET, ["milk"], ("milk",), TODAY)
