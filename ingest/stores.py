"""Find and verify store codes for banners that are not ingested yet.

    python -m ingest.stores discover zehrs fortinos maxi --near 43.59,-79.64
    python -m ingest.stores verify zehrs/0554 maxi/8676

Read-only: it searches the API and never touches the database. A code this
prints as verified still goes through a migration and targets.json, like every
store before it.

It exists because a guessed storeId returns HTTP 200 with zero results, which
is exactly what a working store with nothing in stock looks like. Guessed codes
for Zehrs, Maxi and Fortinos all came back empty (docs/data-sources.md). So a
code is only reported as verified once the canary search has found products at
it, the same check every nightly run makes before ingesting a store.

Cost: one request per banner to list its stores, plus usually one per store
checked, at the same 1 req/s floor as the nightly run.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from dataclasses import dataclass
from typing import Any

from ingest.config import ConfigError, load_settings
from ingest.sources.loblaw import (
    AccessDenied,
    IngestError,
    LoblawClient,
    StoreVerificationError,
)

log = logging.getLogger("ingest.stores")

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_ACCESS_DENIED = 2

# How many of a banner's stores `discover` canary-checks by default. Each check
# is usually one request, and one verified store per banner is all a migration
# needs; three leaves room for a store that has no online grocery.
DEFAULT_CHECKS = 3

# The response shape of pickup-locations is unverified, so every field is read
# from the first of several plausible paths. `discover` prints one raw entry,
# which is what turns these guesses into a documented contract.
_ID_PATHS = ("storeId", "id", "storeNumber", "code")
_NAME_PATHS = ("name", "storeName", "displayName")
_CITY_PATHS = ("address.town", "address.city", "address.locality")
_REGION_PATHS = ("address.region", "address.province", "address.regionCode", "address.state")
_POSTAL_PATHS = ("address.postalCode", "address.zip")
_LAT_PATHS = ("geoPoint.latitude", "location.latitude", "latitude", "lat")
_LNG_PATHS = ("geoPoint.longitude", "location.longitude", "longitude", "lng")
_BANNER_PATHS = ("storeBannerId", "bannerId", "banner")


@dataclass(frozen=True)
class StoreLocation:
    banner: str
    store_id: str
    name: str
    city: str
    region: str
    postal_code: str
    lat: float | None
    lng: float | None

    @property
    def key(self) -> str:
        return f"{self.banner}/{self.store_id}"


def _lookup(entry: dict[str, Any], path: str) -> Any:
    value: Any = entry
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _first(entry: dict[str, Any], paths: tuple[str, ...]) -> Any:
    for path in paths:
        value = _lookup(entry, path)
        if value not in (None, ""):
            return value
    return None


def _text(value: Any) -> str:
    """Flatten a field that may arrive as a string or as {isocode, name}."""
    if value is None:
        return ""
    if isinstance(value, dict):
        return _text(value.get("isocode") or value.get("name") or value.get("code"))
    return str(value).strip()


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def parse_location(banner: str, entry: dict[str, Any]) -> StoreLocation | None:
    """One pickup-locations entry, or None if it names no store or another banner."""
    store_id = _text(_first(entry, _ID_PATHS))
    if not store_id:
        return None
    entry_banner = _text(_first(entry, _BANNER_PATHS))
    if entry_banner and entry_banner.lower() != banner.lower():
        return None
    return StoreLocation(
        banner=banner,
        store_id=store_id,
        name=_text(_first(entry, _NAME_PATHS)),
        city=_text(_first(entry, _CITY_PATHS)),
        region=_text(_first(entry, _REGION_PATHS)),
        postal_code=_text(_first(entry, _POSTAL_PATHS)),
        lat=_number(_first(entry, _LAT_PATHS)),
        lng=_number(_first(entry, _LNG_PATHS)),
    )


def distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance. Only used to order stores, so a sphere will do."""
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    )
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def order_by_distance(
    stores: list[StoreLocation], near: tuple[float, float] | None
) -> list[tuple[StoreLocation, float | None]]:
    """Nearest first when a point is given; stores with no coordinates go last."""
    if near is None:
        return [(store, None) for store in stores]
    placed: list[tuple[StoreLocation, float | None]] = []
    for store in stores:
        km = None
        if store.lat is not None and store.lng is not None:
            km = distance_km(near, (store.lat, store.lng))
        placed.append((store, km))
    return sorted(placed, key=lambda pair: (pair[1] is None, pair[1] or 0.0))


def check(client: LoblawClient, banner: str, store_id: str) -> str:
    """Canary-verify one code. Returns a short status for the report."""
    try:
        hits = client.verify_store(banner, store_id)
    except StoreVerificationError:
        return "EMPTY -- do not use"
    except AccessDenied:
        raise
    except IngestError as exc:
        return f"ERROR {exc}"
    return f"VERIFIED ({hits} canary hits)"


def _shape(value: Any, depth: int = 0) -> Any:
    """Key names and value types only, for documenting an unknown response."""
    if isinstance(value, dict) and depth < 2:
        return {key: _shape(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list):
        return [_shape(value[0], depth + 1)] if value else []
    return type(value).__name__


def discover(
    client: LoblawClient, banner: str, *, checks: int, near: tuple[float, float] | None
) -> bool:
    """List a banner's stores and canary-check the first few. True if one verified."""
    print(f"\n=== {banner}")
    try:
        entries = client.pickup_locations(banner)
    except AccessDenied:
        raise
    except IngestError as exc:
        print(f"  store list unavailable: {exc}")
        return False

    print(f"  {len(entries)} location(s) returned")
    if entries:
        print("  shape of one entry: " + json.dumps(_shape(entries[0]), sort_keys=True))
        print("  first entry: " + json.dumps(entries[0], sort_keys=True)[:1500])

    stores = [store for entry in entries if (store := parse_location(banner, entry))]
    if not stores:
        print("  no entry could be read as a store of this banner")
        return False

    verified = False
    for index, (store, km) in enumerate(order_by_distance(stores, near)):
        status = check(client, banner, store.store_id) if index < checks else ""
        verified = verified or status.startswith("VERIFIED")
        where = ", ".join(part for part in (store.city, store.region, store.postal_code) if part)
        distance = f"{km:6.1f} km" if km is not None else ""
        print(f"  {store.key:<18}{distance:>10}  {store.name[:34]:<34} {where[:32]:<32} {status}")
    return verified


def _point(raw: str) -> tuple[float, float]:
    try:
        lat, lng = (float(part) for part in raw.split(","))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected LAT,LNG, got {raw!r}") from exc
    return lat, lng


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m ingest.stores", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    found = sub.add_parser("discover", help="List a banner's stores and canary-check some.")
    found.add_argument("banners", nargs="+", metavar="BANNER")
    found.add_argument(
        "--checks",
        type=int,
        default=DEFAULT_CHECKS,
        metavar="N",
        help=f"Canary-check the first N stores per banner (default {DEFAULT_CHECKS}).",
    )
    found.add_argument(
        "--near",
        type=_point,
        metavar="LAT,LNG",
        help="Order stores by distance from this point, so the checks go to the nearest.",
    )

    verify = sub.add_parser("verify", help="Canary-check specific store codes.")
    verify.add_argument("stores", nargs="+", metavar="BANNER/CODE")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)

    try:
        settings = load_settings(require_database=False)
    except ConfigError as exc:
        log.error("%s", exc)
        return EXIT_FAILURE

    ok = True
    with LoblawClient(
        settings.pcx_api_key, rate_limit_seconds=settings.rate_limit_seconds
    ) as client:
        try:
            if args.command == "discover":
                for banner in args.banners:
                    ok = discover(client, banner, checks=args.checks, near=args.near) and ok
            else:
                for key in args.stores:
                    banner, _, store_id = key.partition("/")
                    if not banner or not store_id:
                        print(f"{key}: expected BANNER/CODE")
                        ok = False
                        continue
                    status = check(client, banner, store_id)
                    ok = ok and status.startswith("VERIFIED")
                    print(f"{key:<20} {status}")
        except AccessDenied as exc:
            log.error("ACCESS DENIED: %s", exc)
            return EXIT_ACCESS_DENIED

    return EXIT_OK if ok else EXIT_FAILURE


if __name__ == "__main__":
    sys.exit(main())
