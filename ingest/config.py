"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()

PCX_BASE_URL = "https://api.pcexpress.ca/pcx-bff/api/v1"

# Banner slugs confirmed to resolve against the API. Slugs that have not been
# verified with a known-good storeId are deliberately excluded: a bad storeId
# returns HTTP 200 with zero results, so an unverified banner looks identical
# to a working one that happens to be out of stock.
VERIFIED_BANNERS = ("nofrills", "superstore", "loblaw")

# Terms that must always return at least one result for a healthy store.
# Used to distinguish "store has nothing matching" from "storeId is wrong".
CANARY_TERMS = ("milk", "bread")


@dataclass(frozen=True)
class Settings:
    api_key: str
    database_url: str
    rate_limit_seconds: float

    @classmethod
    def from_env(cls) -> Settings:
        api_key = os.environ.get("PCX_API_KEY", "")
        if not api_key:
            raise RuntimeError("PCX_API_KEY is not set. Copy .env.example to .env.")
        return cls(
            api_key=api_key,
            database_url=os.environ.get("DATABASE_URL", ""),
            rate_limit_seconds=float(os.environ.get("INGEST_RATE_LIMIT_SECONDS", "1.0")),
        )
