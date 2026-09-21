"""Client tests.

These pin the parts of the contract where being wrong fails *silently*: the
date format, the headers, and the fact that an empty result is not an error.
Those are the bugs that produce months of clean-looking empty runs.
"""

from __future__ import annotations

import json
from datetime import date

import httpx
import pytest
import respx
from pydantic import ValidationError

from ingest.sources import loblaw
from ingest.tests.conftest import product_entry, search_payload

API_KEY = "test-key"


def make_client() -> loblaw.LoblawClient:
    return loblaw.LoblawClient(API_KEY, rate_limit_seconds=0.0)


@respx.mock
def test_search_sends_the_verified_contract() -> None:
    route = respx.post(loblaw.SEARCH_URL).mock(
        return_value=httpx.Response(200, json=search_payload())
    )

    make_client().search("nofrills", "3131", "2% milk 4l", on_date=date(2026, 9, 21))

    request = route.calls.last.request
    headers = request.headers
    assert headers["x-apikey"] == API_KEY
    assert headers["baseSiteId"] == "nofrills"
    assert headers["Site-Banner"] == "nofrills"
    assert headers["Business-User-Agent"] == "PCXWEB"
    assert headers["x-loblaw-tenant-id"] == "ONLINE_GROCERIES"

    body = json.loads(request.content)
    assert body["banner"] == "nofrills"
    assert body["storeId"] == "3131"
    assert body["term"] == "2% milk 4l"
    assert body["pickupType"] == "STORE"
    assert body["offerType"] == "OG"


@respx.mock
def test_date_is_ddmmyyyy_not_iso() -> None:
    """An ISO date returns stale or empty pricing with a 200 status."""
    route = respx.post(loblaw.SEARCH_URL).mock(
        return_value=httpx.Response(200, json=search_payload())
    )

    make_client().search("nofrills", "3131", "milk", on_date=date(2026, 9, 21))

    body = json.loads(route.calls.last.request.content)
    assert body["date"] == "21092026"
    assert body["date"] != "2026-09-21"


@respx.mock
def test_banner_switches_by_header_not_hostname() -> None:
    route = respx.post(loblaw.SEARCH_URL).mock(
        return_value=httpx.Response(200, json=search_payload())
    )

    client = make_client()
    client.search("superstore", "1516", "milk")
    client.search("loblaw", "1032", "milk")

    banners = [call.request.headers["Site-Banner"] for call in route.calls]
    assert banners == ["superstore", "loblaw"]
    assert {str(call.request.url) for call in route.calls} == {loblaw.SEARCH_URL}


@respx.mock
def test_unknown_upstream_fields_are_ignored() -> None:
    """A field added upstream must never fail a nightly run."""
    entry = product_entry(aNewFieldNobodyToldUsAbout={"nested": [1, 2, 3]})
    respx.post(loblaw.SEARCH_URL).mock(
        return_value=httpx.Response(200, json=search_payload([entry]))
    )

    response = make_client().search("nofrills", "3131", "milk")

    assert response.results[0].code == "20188873_EA"


@respx.mock
def test_removed_required_field_fails_loudly() -> None:
    """The flip side of extra='ignore': a missing required field still raises."""
    entry = product_entry()
    del entry["code"]
    respx.post(loblaw.SEARCH_URL).mock(
        return_value=httpx.Response(200, json=search_payload([entry]))
    )

    with pytest.raises(ValidationError):
        make_client().search("nofrills", "3131", "milk")


@respx.mock
def test_403_is_a_stop_signal_and_is_never_retried() -> None:
    route = respx.post(loblaw.SEARCH_URL).mock(return_value=httpx.Response(403))

    with pytest.raises(loblaw.AccessDenied):
        make_client().search("nofrills", "3131", "milk")

    assert route.call_count == 1, "403 must not be retried or routed around"


@respx.mock
def test_transient_5xx_is_retried() -> None:
    route = respx.post(loblaw.SEARCH_URL).mock(
        side_effect=[
            httpx.Response(503),
            httpx.Response(200, json=search_payload()),
        ]
    )

    response = make_client().search("nofrills", "3131", "milk")

    assert route.call_count == 2
    assert len(response.results) == 1


@respx.mock
def test_gives_up_after_max_attempts() -> None:
    route = respx.post(loblaw.SEARCH_URL).mock(return_value=httpx.Response(503))

    with pytest.raises(loblaw.IngestError):
        make_client().search("nofrills", "3131", "milk")

    assert route.call_count == loblaw.MAX_ATTEMPTS


@respx.mock
def test_verify_store_stops_at_the_first_canary_that_hits() -> None:
    route = respx.post(loblaw.SEARCH_URL).mock(
        return_value=httpx.Response(200, json=search_payload(total=42))
    )

    assert make_client().verify_store("nofrills", "3131") == 42
    assert route.call_count == 1, "verification should cost one request in the good case"


@respx.mock
def test_verify_store_raises_when_every_canary_is_empty() -> None:
    """A bad storeId returns 200 with zero results, not an error."""
    route = respx.post(loblaw.SEARCH_URL).mock(
        return_value=httpx.Response(200, json=search_payload([], total=0))
    )

    with pytest.raises(loblaw.StoreVerificationError):
        make_client().verify_store("zehrs", "9999")

    assert route.call_count == len(loblaw.CANARY_TERMS)


def test_rate_limiter_enforces_the_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr(loblaw.time, "sleep", slept.append)

    limiter = loblaw.RateLimiter(1.0)
    limiter.wait()
    limiter.wait()

    assert len(slept) == 1, "the first call should not wait"
    assert 0.5 < slept[0] <= 1.0


@respx.mock
def test_401_is_a_stop_signal_and_is_never_retried() -> None:
    """A rotated or invalid key is the likeliest stop signal, not a crash."""
    route = respx.post(loblaw.SEARCH_URL).mock(
        return_value=httpx.Response(
            401,
            json={
                "error": "invalid_client",
                "error_description": "The client credentials provided were invalid.",
            },
        )
    )

    with pytest.raises(loblaw.AccessDenied) as caught:
        make_client().search("nofrills", "3131", "milk")

    assert caught.value.status_code == 401
    assert route.call_count == 1, "401 must not be retried"


@respx.mock
def test_403_carries_its_status_too() -> None:
    route = respx.post(loblaw.SEARCH_URL).mock(return_value=httpx.Response(403))

    with pytest.raises(loblaw.AccessDenied) as caught:
        make_client().search("nofrills", "3131", "milk")

    assert caught.value.status_code == 403
    assert route.call_count == 1


@respx.mock
def test_unexpected_status_raises_ingest_error_not_a_raw_httpx_error() -> None:
    """Callers catch IngestError; anything else escapes as an ugly traceback."""
    respx.post(loblaw.SEARCH_URL).mock(return_value=httpx.Response(422))

    with pytest.raises(loblaw.IngestError):
        make_client().search("nofrills", "3131", "milk")
