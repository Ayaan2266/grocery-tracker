"""Client for the Loblaw PCX product search API.

One endpoint and one static API key serve every Loblaw banner (No Frills,
Superstore, Loblaws, Zehrs, Fortinos, Maxi...). The banner is selected by
headers plus the request body, not by hostname.

Contract verified live on 2026-09-20. See docs/data-sources.md.

Two things about this API will bite you if you forget them:

1. `date` is DDMMYYYY, not ISO. The wrong format returns stale or empty pricing
   with a 200 status.
2. An invalid storeId returns HTTP 200 with `pagination.totalResults == 0`.
   There is no error. `verify_store` exists so that months of empty nightly
   runs cannot masquerade as success.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from datetime import date as date_type
from typing import Any

import httpx

from ingest.config import CANARY_TERMS, PCX_BASE_URL, Settings
from ingest.models import SearchResponse

PAGE_SIZE = 48


class StoreVerificationError(RuntimeError):
    """Raised when a storeId returns nothing for a term every store stocks."""


def pcx_date(when: date_type | None = None) -> str:
    """Format a date the way PCX wants it: DDMMYYYY."""
    when = when or date_type.today()
    return when.strftime("%d%m%Y")


def _headers(api_key: str, banner: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Language": "en",
        "baseSiteId": banner,
        "Site-Banner": banner,
        "Business-User-Agent": "PCXWEB",
        "x-apikey": api_key,
        "x-loblaw-tenant-id": "ONLINE_GROCERIES",
        "x-channel": "web",
        "x-application-type": "web",
    }


def build_search_body(
    banner: str, store_id: str, term: str, *, offset: int = 0, size: int = PAGE_SIZE
) -> dict[str, Any]:
    return {
        "banner": banner,
        "lang": "en",
        "storeId": store_id,
        "term": term,
        "cartId": "",
        "pagination": {"from": offset, "size": size},
        "filters": [],
        "sort": {},
        "date": pcx_date(),
        "pickupType": "STORE",
        "offerType": "OG",
    }


class LoblawClient:
    """Rate-limited, banner-aware client.

    The rate limiter is a plain sleep between requests rather than a token
    bucket. Ingestion is a single-threaded nightly job, so a bucket would add
    concurrency machinery for no benefit. Do not raise the rate: this is an
    undocumented internal API and sustained 403s are a stop signal, not a
    problem to route around.
    """

    def __init__(self, settings: Settings, client: httpx.Client | None = None) -> None:
        self._settings = settings
        self._client = client or httpx.Client(timeout=30.0)
        self._last_request_at = 0.0

    def __enter__(self) -> LoblawClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self._client.close()

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request_at
        wait = self._settings.rate_limit_seconds - elapsed
        if wait > 0:
            time.sleep(wait)
        self._last_request_at = time.monotonic()

    def search(
        self, banner: str, store_id: str, term: str, *, offset: int = 0, size: int = PAGE_SIZE
    ) -> SearchResponse:
        self._throttle()
        response = self._client.post(
            f"{PCX_BASE_URL}/products/search",
            headers=_headers(self._settings.api_key, banner),
            json=build_search_body(banner, store_id, term, offset=offset, size=size),
        )
        response.raise_for_status()
        return SearchResponse.model_validate(response.json())

    def search_all(
        self, banner: str, store_id: str, term: str, *, max_products: int = 200
    ) -> Iterator[Any]:
        """Page through results for one term, capped so a broad term cannot
        turn one search into a thousand requests."""
        offset = 0
        seen = 0
        while seen < max_products:
            page = self.search(banner, store_id, term, offset=offset, size=PAGE_SIZE)
            if not page.results:
                return
            for product in page.results:
                yield product
                seen += 1
                if seen >= max_products:
                    return
            offset += PAGE_SIZE
            if offset >= page.pagination.totalResults:
                return

    def verify_store(self, banner: str, store_id: str) -> None:
        """Fail loudly on a storeId that silently returns nothing.

        Called once per store at the start of a run. Without it, a store code
        that changes upstream produces months of successful-looking empty runs.
        """
        for term in CANARY_TERMS:
            page = self.search(banner, store_id, term, size=1)
            if page.results:
                return
        raise StoreVerificationError(
            f"{banner}/{store_id} returned no results for any canary term "
            f"{CANARY_TERMS}. The storeId is probably wrong or retired."
        )
