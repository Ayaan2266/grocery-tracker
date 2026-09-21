"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# The floor, not a default. docs/data-sources.md commits to ~1 req/sec against
# an undocumented internal API; making it a floor means a stray .env edit
# cannot quietly turn this into something that looks like abuse.
MIN_RATE_LIMIT_SECONDS = 1.0


class ConfigError(RuntimeError):
    """A required setting is missing or unusable."""


@dataclass(frozen=True)
class Settings:
    pcx_api_key: str
    database_url: str | None
    rate_limit_seconds: float


def load_settings(*, require_database: bool = True) -> Settings:
    """Read settings from the environment, falling back to a local .env."""
    load_dotenv()

    api_key = os.environ.get("PCX_API_KEY", "").strip()
    if not api_key:
        raise ConfigError("PCX_API_KEY is not set. Copy .env.example to .env and fill it in.")

    database_url = os.environ.get("DATABASE_URL", "").strip() or None
    if require_database and database_url is None:
        raise ConfigError("DATABASE_URL is not set. Pass --dry-run to run without a database.")

    raw = os.environ.get("INGEST_RATE_LIMIT_SECONDS", "").strip()
    try:
        rate = float(raw) if raw else MIN_RATE_LIMIT_SECONDS
    except ValueError as exc:
        raise ConfigError(f"INGEST_RATE_LIMIT_SECONDS must be a number, got {raw!r}") from exc

    return Settings(
        pcx_api_key=api_key,
        database_url=database_url,
        rate_limit_seconds=max(rate, MIN_RATE_LIMIT_SECONDS),
    )
