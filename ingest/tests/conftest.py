"""Shared fixtures.

Every test here runs offline. respx intercepts httpx at the transport layer,
so a test suite that accidentally hits the real PCX API is not possible --
which matters when the etiquette around that API is a project constraint.
"""

from __future__ import annotations

import time
from typing import Any

import pytest


@pytest.fixture(autouse=True)
def no_real_sleeping(monkeypatch: pytest.MonkeyPatch) -> None:
    """Collapse rate-limit and backoff waits so the suite stays fast."""
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)


def product_entry(**overrides: Any) -> dict[str, Any]:
    """A search result shaped like the live response verified on 2026-09-20."""
    entry: dict[str, Any] = {
        "code": "20188873_EA",
        "name": "2% Milk",
        "brand": "Neilson",
        "packageSize": "4 L",
        "stockStatus": "OK",
        "prices": {
            "price": {"value": 6.44},
            "wasPrice": None,
            "comparisonPrices": [],
        },
    }
    entry.update(overrides)
    return entry


def search_payload(
    results: list[dict[str, Any]] | None = None, total: int | None = None
) -> dict[str, Any]:
    results = [product_entry()] if results is None else results
    return {
        "results": results,
        "pagination": {
            "from": 0,
            "size": 48,
            "totalResults": len(results) if total is None else total,
        },
    }
