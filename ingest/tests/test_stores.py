"""Store discovery tests.

What must hold whatever the store list does next: a code is only called
verified when the canary finds products at it, a missing or odd store list is
reported rather than crashing, and a stop signal still stops everything.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from ingest import stores
from ingest.sources import loblaw
from ingest.tests.conftest import search_payload


@pytest.fixture(autouse=True)
def api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PCX_API_KEY", "test-key")
    monkeypatch.delenv("DATABASE_URL", raising=False)


def location(store_id: str, *, banner: str = "zehrs", lat: float = 43.4, lng: float = -80.5):
    return {
        "storeId": store_id,
        "storeBannerId": banner,
        "name": f"Store {store_id}",
        "address": {"town": "Kitchener", "region": {"isocode": "CA-ON"}, "postalCode": "N2M"},
        "geoPoint": {"latitude": lat, "longitude": lng},
    }


def test_parse_location_reads_nested_fields() -> None:
    store = stores.parse_location("zehrs", location("0554"))

    assert store is not None
    assert store.key == "zehrs/0554"
    assert (store.city, store.region, store.postal_code) == ("Kitchener", "CA-ON", "N2M")
    assert (store.lat, store.lng) == (43.4, -80.5)


def test_parse_location_drops_other_banners_and_entries_without_an_id() -> None:
    assert stores.parse_location("zehrs", location("1", banner="fortinos")) is None
    assert stores.parse_location("zehrs", {"name": "no id here"}) is None


def test_order_by_distance_puts_the_nearest_first_and_unplaced_last() -> None:
    near = stores.parse_location("zehrs", location("near", lat=43.65, lng=-79.38))
    far = stores.parse_location("zehrs", location("far", lat=45.4, lng=-75.7))
    nowhere = stores.parse_location("zehrs", {"storeId": "nowhere"})
    assert near and far and nowhere

    ordered = stores.order_by_distance([nowhere, far, near], (43.6534, -79.3839))

    assert [store.store_id for store, _ in ordered] == ["near", "far", "nowhere"]
    assert ordered[-1][1] is None


@respx.mock
def test_discover_checks_only_the_nearest_stores(capsys: pytest.CaptureFixture[str]) -> None:
    respx.get(loblaw.PICKUP_LOCATIONS_URL).mock(
        return_value=httpx.Response(
            200,
            json=[
                location("far", lat=45.4, lng=-75.7),
                location("near", lat=43.65, lng=-79.38),
                location("other", banner="fortinos"),
            ],
        )
    )
    search = respx.post(loblaw.SEARCH_URL).mock(
        return_value=httpx.Response(200, json=search_payload(total=12))
    )

    code = stores.main(["discover", "zehrs", "--checks", "1", "--near", "43.6534,-79.3839"])

    assert code == stores.EXIT_OK
    assert search.call_count == 1
    body = search.calls.last.request.content.decode()
    assert '"storeId":"near"' in body.replace(" ", "")
    out = capsys.readouterr().out
    assert "zehrs/near" in out and "VERIFIED" in out
    assert "zehrs/other" not in out


@respx.mock
def test_an_empty_store_is_never_reported_as_verified(
    capsys: pytest.CaptureFixture[str],
) -> None:
    respx.post(loblaw.SEARCH_URL).mock(
        return_value=httpx.Response(200, json=search_payload([], total=0))
    )

    code = stores.main(["verify", "maxi/9999"])

    assert code == stores.EXIT_FAILURE
    assert "EMPTY" in capsys.readouterr().out


@respx.mock
def test_a_missing_store_list_is_reported_not_raised(
    capsys: pytest.CaptureFixture[str],
) -> None:
    respx.get(loblaw.PICKUP_LOCATIONS_URL).mock(return_value=httpx.Response(404))

    code = stores.main(["discover", "fortinos"])

    assert code == stores.EXIT_FAILURE
    assert "store list unavailable" in capsys.readouterr().out


@respx.mock
def test_a_wrapped_store_list_is_unwrapped() -> None:
    respx.get(loblaw.PICKUP_LOCATIONS_URL).mock(
        return_value=httpx.Response(200, json={"results": [location("0554")]})
    )

    entries = loblaw.LoblawClient("k", rate_limit_seconds=0.0).pickup_locations("zehrs")

    assert [entry["storeId"] for entry in entries] == ["0554"]


@respx.mock
def test_pickup_locations_sends_the_banner_headers() -> None:
    route = respx.get(loblaw.PICKUP_LOCATIONS_URL).mock(return_value=httpx.Response(200, json=[]))

    loblaw.LoblawClient("k", rate_limit_seconds=0.0).pickup_locations("maxi")

    request = route.calls.last.request
    assert request.url.params["bannerIds"] == "maxi"
    assert request.headers["Site-Banner"] == "maxi"
    assert request.headers["x-apikey"] == "k"


@respx.mock
def test_a_stop_signal_stops_discovery() -> None:
    route = respx.get(loblaw.PICKUP_LOCATIONS_URL).mock(return_value=httpx.Response(401))

    code = stores.main(["discover", "zehrs", "fortinos"])

    assert code == stores.EXIT_ACCESS_DENIED
    assert route.call_count == 1, "the second banner must not be tried after a 401"


@respx.mock
def test_listing_without_checks_succeeds_without_a_search() -> None:
    respx.get(loblaw.PICKUP_LOCATIONS_URL).mock(
        return_value=httpx.Response(200, json=[location("0554")])
    )
    search = respx.post(loblaw.SEARCH_URL)

    assert stores.main(["discover", "zehrs", "--checks", "0"]) == stores.EXIT_OK
    assert search.call_count == 0
