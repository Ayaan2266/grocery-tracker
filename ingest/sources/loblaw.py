"""Client for the Loblaw PC Express (PCX) product search API.

One endpoint and one key serve every Loblaw banner; the banner is selected by
headers plus the request body, not by hostname. Contract verified live on
2026-09-20 -- see docs/data-sources.md, which also records the endpoints that
are confirmed *not* to exist.
"""

from __future__ import annotations

import logging
import time
from datetime import date
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger(__name__)

SEARCH_URL = "https://api.pcexpress.ca/pcx-bff/api/v1/products/search"

DEFAULT_PAGE_SIZE = 48
DEFAULT_TIMEOUT = 30.0
MAX_ATTEMPTS = 3
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})

# Never retried, never routed around. 401 is what this API actually returns
# for a bad or rotated key -- observed live, not assumed.
STOP_SIGNAL_STATUS = frozenset({401, 403})

# Terms every grocery store in the country stocks. Used to prove a storeId
# actually resolves before we trust an empty result from it.
CANARY_TERMS = ("milk", "bread", "eggs")


class IngestError(RuntimeError):
    """Base class for ingestion failures."""


class AccessDenied(IngestError):
    """HTTP 401 or 403. Never retried, never routed around.

    Both are stop signals but they mean different things, so the status comes
    along with the exception:

    401 -- the credential was rejected. The storefront ships a new key and
           PCX_API_KEY needs re-capturing. This is the key-rotation case the
           README calls a stop signal, and it is the likelier of the two.
    403 -- the request was understood and refused. That is the answer to
           whether server-side access works at all.

    Personal, non-commercial use of an undocumented internal API is only
    defensible while it stays gentle. Neither of these is a problem to solve
    with proxies.
    """

    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


_STOP_SIGNAL_REMEDY = {
    401: (
        "the credential was rejected -- the key is invalid or has rotated. "
        "Re-capture x-apikey from the storefront bundle and update PCX_API_KEY."
    ),
    403: (
        "the request was understood and refused -- server-side access is "
        "blocked. Do not route around this."
    ),
}


class StoreVerificationError(IngestError):
    """Canary terms all came back empty, so the storeId is not trustworthy."""


class _Model(BaseModel):
    # extra="ignore" because the upstream API is undocumented and adds fields
    # without notice; a new field must never fail a nightly run. The asymmetry
    # is deliberate -- a *removed* required field still raises a validation
    # error, which is exactly when a loud failure is wanted.
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class Price(_Model):
    value: float


class Prices(_Model):
    price: Price | None = None

    # Non-null only when the item is on sale. This is the only sale signal the
    # API gives us. The browser capture showed an object with a .value, but the
    # shape was never pinned down against a second sale item, so a bare number
    # is accepted too: guessing wrong here silently discards the one field the
    # "is this actually a deal" question depends on.
    was_price: Price | float | None = Field(default=None, alias="wasPrice")

    # Already normalized upstream to $/100g or $/100ml. The *inner* shape is
    # not verified, so it is carried through as raw dicts and
    # normalize.extract_unit_price owns the parsing.
    comparison_prices: list[dict[str, Any]] = Field(default_factory=list, alias="comparisonPrices")


class Product(_Model):
    # Retailer SKU, e.g. "20188873_EA". Natural key within a retailer, not
    # portable across them -- that is what match.py is for.
    code: str
    name: str
    brand: str | None = None
    package_size: str | None = Field(default=None, alias="packageSize")
    stock_status: str | None = Field(default=None, alias="stockStatus")

    # Optional rather than required: a single priceless entry is data variance,
    # not a contract break, and should not fail the whole night. run.py counts
    # the skips so a systemic change still shows up in the summary.
    prices: Prices | None = None


class Pagination(_Model):
    total_results: int = Field(default=0, alias="totalResults")


class SearchResponse(_Model):
    results: list[Product] = Field(default_factory=list)
    pagination: Pagination = Field(default_factory=Pagination)


class RateLimiter:
    """Minimum wall-clock gap between outbound requests.

    A floor on the gap between call starts, deliberately not a token bucket:
    a bucket permits bursts, and the point is to never burst against an API we
    have no permission to be using.
    """

    def __init__(self, min_interval_seconds: float) -> None:
        self._min_interval = max(0.0, min_interval_seconds)
        self._last_start: float | None = None

    def wait(self) -> None:
        if self._last_start is not None:
            remaining = self._min_interval - (time.monotonic() - self._last_start)
            if remaining > 0:
                time.sleep(remaining)
        self._last_start = time.monotonic()


class LoblawClient:
    """Rate-limited PCX search client."""

    def __init__(
        self,
        api_key: str,
        *,
        rate_limit_seconds: float = 1.0,
        timeout: float = DEFAULT_TIMEOUT,
        client: httpx.Client | None = None,
    ) -> None:
        self._api_key = api_key
        self._limiter = RateLimiter(rate_limit_seconds)
        self._client = client if client is not None else httpx.Client(timeout=timeout)
        self._owns_client = client is None

    def __enter__(self) -> LoblawClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _headers(self, banner: str) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Accept-Language": "en",
            "baseSiteId": banner,
            "Site-Banner": banner,
            "Business-User-Agent": "PCXWEB",
            "x-apikey": self._api_key,
            "x-loblaw-tenant-id": "ONLINE_GROCERIES",
            "x-channel": "web",
            "x-application-type": "web",
        }

    @staticmethod
    def _body(
        banner: str, store_id: str, term: str, *, page_size: int, on_date: date
    ) -> dict[str, Any]:
        return {
            "banner": banner,
            "lang": "en",
            "storeId": store_id,
            "term": term,
            "cartId": "",
            "pagination": {"from": 0, "size": page_size},
            "filters": [],
            "sort": {},
            # DDMMYYYY, not ISO. An ISO date returns stale or empty pricing
            # with a 200 status, which is the worst possible failure mode.
            "date": on_date.strftime("%d%m%Y"),
            "pickupType": "STORE",
            "offerType": "OG",
        }

    def search(
        self,
        banner: str,
        store_id: str,
        term: str,
        *,
        page_size: int = DEFAULT_PAGE_SIZE,
        on_date: date | None = None,
    ) -> SearchResponse:
        on_date = on_date or date.today()
        headers = self._headers(banner)
        body = self._body(banner, store_id, term, page_size=page_size, on_date=on_date)

        last_error: Exception | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            self._limiter.wait()
            try:
                response = self._client.post(SEARCH_URL, json=body, headers=headers)
            except httpx.HTTPError as exc:
                last_error = exc
                log.warning(
                    "%s/%s %r transport error (attempt %d): %s",
                    banner,
                    store_id,
                    term,
                    attempt,
                    exc,
                )
                self._backoff(attempt)
                continue

            if response.status_code in STOP_SIGNAL_STATUS:
                raise AccessDenied(
                    f"HTTP {response.status_code} for banner={banner} store={store_id}. "
                    f"Stop signal: {_STOP_SIGNAL_REMEDY[response.status_code]}",
                    status_code=response.status_code,
                )

            if response.status_code in RETRYABLE_STATUS:
                last_error = httpx.HTTPStatusError(
                    f"HTTP {response.status_code}", request=response.request, response=response
                )
                log.warning(
                    "%s/%s %r HTTP %d (attempt %d)",
                    banner,
                    store_id,
                    term,
                    response.status_code,
                    attempt,
                )
                self._backoff(attempt)
                continue

            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                # Callers catch IngestError. A raw httpx error would sail past
                # every handler in run.py and end the night in a traceback.
                raise IngestError(
                    f"unexpected HTTP {response.status_code} for banner={banner} "
                    f"store={store_id} term={term!r}"
                ) from exc

            return SearchResponse.model_validate(response.json())

        raise IngestError(
            f"Giving up on banner={banner} store={store_id} term={term!r} after "
            f"{MAX_ATTEMPTS} attempts: {last_error}"
        )

    @staticmethod
    def _backoff(attempt: int) -> None:
        if attempt < MAX_ATTEMPTS:
            time.sleep(2 ** (attempt - 1))

    def verify_store(
        self,
        banner: str,
        store_id: str,
        *,
        terms: tuple[str, ...] = CANARY_TERMS,
        on_date: date | None = None,
    ) -> int:
        """Prove a storeId resolves before ingesting it. Returns the canary hit count.

        A bad storeId returns HTTP 200 with totalResults: 0, not an error.
        Guessed IDs for Zehrs, Maxi and Fortinos all silently returned empty.
        Without this guard, a store code that changes upstream produces months
        of successful-looking empty runs and the price history -- the entire
        point of the project -- is quietly missing.

        Returns on the first term that comes back non-empty, so the usual cost
        is a single extra request per store per night.
        """
        for term in terms:
            response = self.search(banner, store_id, term, page_size=1, on_date=on_date)
            if response.pagination.total_results > 0:
                log.info("store %s/%s verified on canary %r", banner, store_id, term)
                return response.pagination.total_results

        raise StoreVerificationError(
            f"store {banner}/{store_id} returned zero results for every canary term "
            f"({', '.join(terms)}). The store code is probably wrong or retired -- "
            "an empty ingest here would look like success."
        )
