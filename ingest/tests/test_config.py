from __future__ import annotations

import pytest

from ingest import config
from ingest.config import ConfigError, load_settings


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ignore any developer .env so the suite reads only what a test sets."""
    monkeypatch.setattr(config, "load_dotenv", lambda *a, **k: False)
    for name in ("PCX_API_KEY", "DATABASE_URL", "INGEST_RATE_LIMIT_SECONDS"):
        monkeypatch.delenv(name, raising=False)


def test_missing_api_key_is_a_clear_error(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ConfigError, match="PCX_API_KEY"):
        load_settings(require_database=False)


def test_database_url_is_optional_for_dry_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PCX_API_KEY", "k")
    settings = load_settings(require_database=False)
    assert settings.database_url is None


def test_database_url_is_required_for_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PCX_API_KEY", "k")
    with pytest.raises(ConfigError, match="DATABASE_URL"):
        load_settings(require_database=True)


def test_rate_limit_cannot_be_lowered_below_the_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ~1 req/sec ceiling is a project constraint, not a default."""
    monkeypatch.setenv("PCX_API_KEY", "k")
    monkeypatch.setenv("INGEST_RATE_LIMIT_SECONDS", "0.01")
    assert load_settings(require_database=False).rate_limit_seconds == 1.0


def test_rate_limit_can_be_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PCX_API_KEY", "k")
    monkeypatch.setenv("INGEST_RATE_LIMIT_SECONDS", "2.5")
    assert load_settings(require_database=False).rate_limit_seconds == 2.5
