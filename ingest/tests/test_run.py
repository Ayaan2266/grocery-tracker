"""Run-loop tests. No network, no database -- the client is stubbed."""

from __future__ import annotations

from datetime import date

import pytest

from ingest import run
from ingest.config import Settings
from ingest.run import StoreTarget, ingest_store
from ingest.sources.loblaw import AccessDenied, IngestError, SearchResponse, StoreVerificationError
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


def test_canary_transport_failure_is_a_store_failure(monkeypatch) -> None:
    client = StubClient({"milk": [product_entry()]})

    def fail(*args, **kwargs):
        raise IngestError("giving up after retries")

    monkeypatch.setattr(client, "verify_store", fail)
    outcome = ingest_store(client, TARGET, ["milk"], ("milk",), TODAY)
    assert not outcome.ok
    assert client.searched == []


@pytest.mark.parametrize("entries", [[], [product_entry(prices=None)]])
def test_store_without_usable_prices_does_not_report_success(entries) -> None:
    outcome = ingest_store(StubClient({"milk": entries}), TARGET, ["milk"], ("milk",), TODAY)
    assert not outcome.ok
    assert outcome.rows == []


@pytest.mark.parametrize("limit", ["0", "-1"])
def test_limit_must_be_positive(limit) -> None:
    with pytest.raises(SystemExit):
        run.build_parser().parse_args(["--limit", limit])


def test_unknown_store_is_rejected_even_beside_a_valid_one(monkeypatch) -> None:
    monkeypatch.setattr(run, "load_settings", lambda **kw: Settings("k", None, 1))
    assert run.main(["--dry-run", "--store", TARGET.key, "--store", "typo/9999"]) == 1


def test_stop_signal_keeps_completed_stores_without_more_requests(monkeypatch) -> None:
    stores = [TARGET, run.StoreTarget("loblaw", "1032", "Loblaws"), TARGET]
    monkeypatch.setattr(run, "load_settings", lambda **kw: Settings("k", "postgresql://test", 1))
    monkeypatch.setattr(run, "load_targets", lambda: run.Targets(stores, ("milk",), ["milk"]))
    monkeypatch.setattr(run, "preflight", lambda *args: None)
    fetched = []
    written = []

    def fetch(client, target, *args):
        fetched.append(target)
        if target.banner == "loblaw":
            raise AccessDenied("stop", status_code=403)
        return run.StoreOutcome(target, rows=[object()])

    monkeypatch.setattr(run, "ingest_store", fetch)
    monkeypatch.setattr(run, "_write", lambda url, outcomes, day: written.extend(outcomes))
    assert run.main([]) == 2
    assert fetched == stores[:2]
    assert [o.target for o in written] == [TARGET]


def _nightly(monkeypatch, *, ran: bool) -> list:
    """main() with the database stubbed; returns the stores it fetched."""
    monkeypatch.setattr(run, "load_settings", lambda **kw: Settings("k", "postgresql://test", 1))
    monkeypatch.setattr(run, "load_targets", lambda: run.Targets([TARGET], ("milk",), ["milk"]))
    monkeypatch.setattr(run, "preflight", lambda *args: None)
    monkeypatch.setattr(run, "already_ran", lambda *args: ran)
    fetched = []

    def fetch(client, target, *args):
        fetched.append(target)
        return run.StoreOutcome(target, rows=[object()])

    monkeypatch.setattr(run, "ingest_store", fetch)
    monkeypatch.setattr(run, "_write", lambda *args: None)
    monkeypatch.setattr(run, "print_summary", lambda *args, **kw: None)
    return fetched


def test_once_per_day_spends_no_requests_when_the_night_already_ran(monkeypatch) -> None:
    fetched = _nightly(monkeypatch, ran=True)
    assert run.main(["--once-per-day"]) == 0
    assert fetched == []


def test_once_per_day_runs_when_any_store_is_missing_a_run(monkeypatch) -> None:
    fetched = _nightly(monkeypatch, ran=False)
    assert run.main(["--once-per-day"]) == 0
    assert fetched == [TARGET]


def test_without_once_per_day_an_earlier_run_does_not_stop_a_rerun(monkeypatch) -> None:
    fetched = _nightly(monkeypatch, ran=True)
    assert run.main([]) == 0
    assert fetched == [TARGET]


def test_a_failed_check_for_an_earlier_run_lets_the_night_go_ahead(monkeypatch) -> None:
    from ingest import db

    def refuse(url):
        raise db.psycopg.OperationalError("connection refused")

    monkeypatch.setattr(db, "connect", refuse)
    assert run.already_ran("postgresql://test", [TARGET], date(2026, 10, 1)) is False
