import json
import re
from datetime import date
from pathlib import Path

import httpx
import pytest

from ingest.config import Settings
from ingest.sources.loblaw import (
    LoblawClient,
    StoreVerificationError,
    build_search_body,
    pcx_date,
)

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "search_nofrills_milk.json").read_text())


@pytest.fixture
def settings() -> Settings:
    return Settings(api_key="test-key", database_url="", rate_limit_seconds=0.0)


def _client(settings, handler) -> LoblawClient:
    transport = httpx.MockTransport(handler)
    return LoblawClient(settings, client=httpx.Client(transport=transport))


def test_date_is_ddmmyyyy_not_iso():
    """Wrong format returns stale or empty pricing with a 200 status, which is
    the worst kind of bug to find three weeks later."""
    assert pcx_date(date(2026, 9, 20)) == "20092026"
    assert pcx_date(date(2026, 1, 5)) == "05012026"


def test_search_body_matches_the_verified_contract():
    body = build_search_body("nofrills", "3131", "milk", offset=0, size=10)
    assert body["banner"] == "nofrills"
    assert body["storeId"] == "3131"
    assert body["pickupType"] == "STORE"
    assert body["offerType"] == "OG"
    assert body["pagination"] == {"from": 0, "size": 10}
    assert len(body["date"]) == 8


def test_banner_is_sent_in_both_headers(settings):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json=FIXTURE)

    with _client(settings, handler) as client:
        client.search("superstore", "1516", "milk")

    assert seen["basesiteid"] == "superstore"
    assert seen["site-banner"] == "superstore"
    assert seen["x-apikey"] == "test-key"


def test_no_api_key_literal_is_committed():
    """Guards against a key being pasted into the client.

    Matches on shape, not on the key itself -- asserting `"<the key>" not in
    source` would put the key in this file and commit it, which is the exact
    thing being guarded against.
    """
    package = Path(__file__).parents[1]
    key_shaped = re.compile(r"[\"'][A-Za-z0-9]{28,48}[\"']")
    for path in package.rglob("*.py"):
        if path.parent.name == "tests":
            continue
        for literal in key_shaped.findall(path.read_text()):
            pytest.fail(f"{path.name} contains a key-shaped literal: {literal[:6]}...")


def test_verify_store_raises_on_silent_empty_result(settings):
    """A bad storeId returns HTTP 200 with zero results. Without this guard,
    months of empty nightly runs look like success."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [], "pagination": {"totalResults": 0}})

    with _client(settings, handler) as client, pytest.raises(StoreVerificationError):
        client.verify_store("zehrs", "9999")


def test_verify_store_passes_on_a_real_store(settings):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=FIXTURE)

    with _client(settings, handler) as client:
        client.verify_store("nofrills", "3131")


def test_search_all_stops_at_the_cap(settings):
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={**FIXTURE, "pagination": {"totalResults": 10_000}})

    with _client(settings, handler) as client:
        products = list(client.search_all("nofrills", "3131", "milk", max_products=5))

    assert len(products) == 5
    assert calls["n"] == 2
