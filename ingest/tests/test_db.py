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


def test_observations_never_overwrite_history() -> None:
    """price_observations is append-only: DO NOTHING, never DO UPDATE."""
    sql = " ".join(db.INSERT_OBSERVATION.split()).upper()
    assert "ON CONFLICT (PRODUCT_ID, OBSERVED_ON) DO NOTHING" in sql
    assert "DO UPDATE" not in sql


def test_products_upsert_because_metadata_is_mutable() -> None:
    """Names and package sizes get re-worded upstream; identity is not history."""
    sql = " ".join(db.UPSERT_PRODUCT.split()).upper()
    assert "ON CONFLICT (STORE_ID, RETAILER_SKU) DO UPDATE" in sql


def test_nothing_updates_or_deletes_price_observations() -> None:
    """Enforces db/migrations/README.md's rule across the whole package."""
    forbidden = re.compile(
        r"\b(UPDATE\s+price_observations|DELETE\s+FROM\s+price_observations"
        r"|TRUNCATE\s+(TABLE\s+)?price_observations)\b",
        re.IGNORECASE,
    )
    offenders = [
        path.relative_to(INGEST_ROOT.parent).as_posix()
        for path in INGEST_ROOT.rglob("*.py")
        if forbidden.search(path.read_text(encoding="utf-8"))
    ]
    assert offenders == [], f"append-only rule violated in: {offenders}"
