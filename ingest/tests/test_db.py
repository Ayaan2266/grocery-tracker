"""Database layer tests.

No live Postgres: psycopg.connect is stubbed. What is worth pinning here is
not the SQL syntax -- Postgres will tell you about that -- but the two
invariants that are easy to break later with a well-meaning edit and hard to
notice once broken.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from ingest import db

INGEST_ROOT = Path(db.__file__).parent


def test_connect_disables_prepared_statements(monkeypatch: pytest.MonkeyPatch) -> None:
    """Transaction-mode pooling and server-side prepared statements do not mix."""
    captured: dict[str, Any] = {}

    def fake_connect(conninfo: str, **kwargs: Any) -> object:
        captured["conninfo"] = conninfo
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(db.psycopg, "connect", fake_connect)
    db.connect("postgresql://user:pw@pooler.supabase.com:6543/postgres")

    assert captured["prepare_threshold"] is None, (
        "psycopg prepares a statement after 5 executions by default; a night "
        "runs these several hundred times"
    )


def test_connect_leaves_transactions_open(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each store commits as a unit, so autocommit must stay off."""
    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        db.psycopg, "connect", lambda conninfo, **kw: captured.update(kw) or object()
    )

    db.connect("postgresql://x")

    assert captured["autocommit"] is False


def test_spans_never_overwrite_history() -> None:
    """A same-day re-run leaves the first write alone: DO NOTHING, never DO UPDATE."""
    sql = " ".join(db.WRITE_SPANS.split()).upper()
    assert "ON CONFLICT (PRODUCT_ID, FIRST_OBSERVED_ON) DO NOTHING" in sql
    assert "DO UPDATE" not in sql


def test_products_upsert_because_metadata_is_mutable() -> None:
    """Names and package sizes get re-worded upstream; identity is not history."""
    sql = " ".join(db.UPSERT_PRODUCTS.split()).upper()
    assert "ON CONFLICT (STORE_ID, RETAILER_SKU) DO UPDATE" in sql


def _production_sources() -> dict[str, str]:
    """Production modules only.

    The test suite is excluded on purpose: it contains forbidden statements as
    assertions that they FAIL, which is the rule being enforced rather than
    broken. test_db_integration.py runs them as the owner and as anon and
    requires every one to be refused.
    """
    return {
        path.relative_to(INGEST_ROOT.parent).as_posix(): path.read_text(encoding="utf-8")
        for path in INGEST_ROOT.rglob("*.py")
        if "tests" not in path.parts
    }


def test_nothing_deletes_price_history() -> None:
    """Enforces db/migrations/README.md's rule across the package."""
    forbidden = re.compile(
        r"\b(UPDATE\s+price_observations"
        r"|(DELETE\s+FROM|TRUNCATE\s+(TABLE\s+)?)(price_observations|price_spans))\b",
        re.IGNORECASE,
    )
    offenders = [name for name, text in _production_sources().items() if forbidden.search(text)]
    assert offenders == [], f"append-only rule violated in: {offenders}"


def test_the_only_update_to_a_span_moves_its_confirmation_date() -> None:
    """Extending a span is the one UPDATE allowed, and it touches one column.

    The trigger in 0006 enforces the same thing inside Postgres. This catches
    it in review, before a migration or a nightly run has to.
    """
    update = re.compile(
        r"UPDATE\s+price_spans\b(?:\s+\w+)?\s+SET\s+(.*?)\s+(?:FROM|WHERE|RETURNING)\b",
        re.IGNORECASE | re.DOTALL,
    )
    assignments = [
        " ".join(match.group(1).split())
        for text in _production_sources().values()
        for match in update.finditer(text)
    ]
    assert assignments == ["last_confirmed_on = %(observed_on)s"]
