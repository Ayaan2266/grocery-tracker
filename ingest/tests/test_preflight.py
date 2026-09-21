"""Preflight tests.

The point of preflight is not that it reports a nice message -- it is that a
bad secret costs one second instead of 500 requests against an API we have no
permission to be using. That is what the last test here pins.
"""

from __future__ import annotations

import httpx
import psycopg
import pytest
import respx

from ingest import config, db
from ingest.run import StoreTarget, load_targets, main, preflight, redact_password
from ingest.sources.loblaw import SEARCH_URL
from ingest.tests.conftest import search_payload

STORES = [StoreTarget(banner="nofrills", store_code="3131", label="No Frills")]


class FakeConnection:
    def __enter__(self) -> FakeConnection:
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "load_dotenv", lambda *a, **k: False)
    monkeypatch.setenv("PCX_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pw@pooler:6543/postgres")


def test_reports_a_connection_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(_url: str):
        raise psycopg.OperationalError('password authentication failed for user "postgres"')

    monkeypatch.setattr(db, "connect", refuse)

    problem = preflight("postgresql://wrong", STORES)

    assert problem is not None
    assert "password authentication failed" in problem


def test_reports_a_store_that_no_migration_has_added(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(db, "connect", lambda _url: FakeConnection())

    def unknown(_conn, banner: str, store_code: str) -> int:
        raise db.UnknownStore(f"no active store for banner={banner} store_code={store_code}")

    monkeypatch.setattr(db, "resolve_store_id", unknown)

    problem = preflight("postgresql://fine", STORES)

    assert problem is not None
    assert "3131" in problem


def test_returns_none_when_everything_resolves(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(db, "connect", lambda _url: FakeConnection())
    monkeypatch.setattr(db, "resolve_store_id", lambda _conn, _banner, _code: 1)

    assert preflight("postgresql://fine", STORES) is None


def test_every_target_store_is_checked(monkeypatch: pytest.MonkeyPatch) -> None:
    """A store missing from the database is worth catching before the fetch."""
    seen: list[tuple[str, str]] = []
    monkeypatch.setattr(db, "connect", lambda _url: FakeConnection())
    monkeypatch.setattr(
        db,
        "resolve_store_id",
        lambda _conn, banner, code: seen.append((banner, code)) or 1,
    )

    stores = load_targets().stores
    preflight("postgresql://fine", stores)

    assert seen == [(s.banner, s.store_code) for s in stores]


@respx.mock
def test_a_failed_preflight_spends_no_api_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    """The whole reason this exists.

    Before preflight, a bad DATABASE_URL was only discovered after every store
    had been fetched -- 504 requests thrown away over a typo in a secret.
    """
    route = respx.post(SEARCH_URL).mock(return_value=httpx.Response(200, json=search_payload()))

    def refuse(_url: str):
        raise psycopg.OperationalError("password authentication failed")

    monkeypatch.setattr(db, "connect", refuse)

    exit_code = main([])

    assert exit_code == 1
    assert route.call_count == 0, "a bad secret must cost zero requests"


@respx.mock
def test_dry_run_skips_preflight_entirely(monkeypatch: pytest.MonkeyPatch) -> None:
    """--dry-run writes nothing, so it must not require a database at all."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    respx.post(SEARCH_URL).mock(return_value=httpx.Response(200, json=search_payload()))

    def explode(_url: str):
        raise AssertionError("preflight must not run for a dry run")

    monkeypatch.setattr(db, "connect", explode)

    assert main(["--dry-run", "--limit", "1"]) == 0


SECRET = "FCfSezBjA3pw"
URL_WITH_SECRET = f"postgresql://postgres.abcdef:{SECRET}@pooler.supabase.com:6543/postgres"


def test_redact_password_removes_it_from_a_message() -> None:
    message = f'connection failed for "{SECRET}" at host pooler.supabase.com'

    cleaned = redact_password(message, URL_WITH_SECRET)

    assert SECRET not in cleaned
    assert "***" in cleaned
    assert "pooler.supabase.com" in cleaned, "only the password should be removed"


def test_redact_password_is_a_noop_without_one() -> None:
    assert redact_password("boom", "postgresql://localhost:5432/db") == "boom"


def test_a_malformed_url_never_echoes_the_driver_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """psycopg quotes the offending part of the string -- usually the password.

    Actions logs on a public repo are public, and GitHub only masks exact
    matches of the whole secret, not fragments of it. This is how a real
    password fragment reached a public log on 2026-09-21.
    """
    fragment = "FCfSezBjA3%.#-m"

    def refuse(_url: str):
        raise psycopg.ProgrammingError(f'invalid percent-encoded token: "{fragment}"')

    monkeypatch.setattr(db, "connect", refuse)

    problem = preflight(f"postgresql://postgres.abcdef:{fragment}@pooler:6543/postgres", STORES)

    assert problem is not None
    assert fragment not in problem, "the driver error leaked credential material"
    assert "%25" in problem, "the message should say how to encode it"


def test_a_connection_error_still_has_its_password_stripped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(_url: str):
        raise psycopg.OperationalError(f"auth failed, tried password {SECRET}")

    monkeypatch.setattr(db, "connect", refuse)

    problem = preflight(URL_WITH_SECRET, STORES)

    assert problem is not None
    assert SECRET not in problem
