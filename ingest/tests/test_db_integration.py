"""Integration tests for the write path, against a real Postgres.

Skipped unless INGEST_TEST_DATABASE_URL is set. CI provides one; locally:

    docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
    export INGEST_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

Everything runs inside a throwaway schema that is dropped afterwards, so the
target database is left as it was found.

These exist because the rest of the suite mocks the database, and mocks cannot
tell you whether the SQL is valid, whether the types line up, or whether
ON CONFLICT DO NOTHING really leaves a historical price alone. That last one is
the guarantee the whole project rests on, so it gets checked for real.
"""

from __future__ import annotations

import os
import uuid
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from ingest import db
from ingest.normalize import NormalizedPrice

psycopg = pytest.importorskip("psycopg")

DATABASE_URL = os.environ.get("INGEST_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="INGEST_TEST_DATABASE_URL is not set")

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
DAY = date(2026, 9, 21)


@pytest.fixture
def conn():
    """A connection whose search_path points at a fresh, disposable schema."""
    schema = f"ingest_test_{uuid.uuid4().hex[:12]}"
    connection = psycopg.connect(DATABASE_URL, autocommit=False)
    try:
        with connection.cursor() as cur:
            cur.execute(f'CREATE SCHEMA "{schema}"')
            cur.execute(f'SET search_path TO "{schema}"')
            for name in ("0001_init.sql", "0002_add_loblaws_store.sql"):
                cur.execute((MIGRATIONS / name).read_text(encoding="utf-8"))
        connection.commit()
        yield connection
    finally:
        connection.rollback()
        with connection.cursor() as cur:
            cur.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        connection.commit()
        connection.close()


def make_row(index: int, price_cents: int = 500) -> NormalizedPrice:
    return NormalizedPrice(
        retailer_sku=f"SKU{index:06d}_EA",
        raw_name=f"Product {index}",
        brand="Neilson",
        package_size="4 L",
        size_value=Decimal("4") if index % 3 else None,
        size_unit="L" if index % 3 else None,
        price_cents=price_cents,
        was_price_cents=price_cents + 100 if index % 4 == 0 else None,
        unit_price_cents=None,
        comparison_unit=None,
        comparison_quantity=None,
        unit_price_source="none",
        in_stock=index % 10 != 0,
    )


def test_migrations_seed_three_verified_stores(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT s.store_code, r.banner_slug
              FROM stores s JOIN retailers r ON r.id = s.retailer_id
             ORDER BY s.id
        """)
        assert cur.fetchall() == [
            ("3131", "nofrills"),
            ("1516", "superstore"),
            ("1032", "loblaw"),
        ]


def test_a_batch_writes_products_and_observations(conn) -> None:
    store_id = db.resolve_store_id(conn, "nofrills", "3131")
    rows = [make_row(i) for i in range(50)]

    result = db.write_store_observations(conn, store_id, rows, DAY)

    assert result.errors == []
    assert result.products_written == 50
    assert result.observations_inserted == 50
    assert result.observations_already_present == 0

    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM products WHERE store_id = %s", (store_id,))
        assert cur.fetchone()[0] == 50
        cur.execute(
            """
            SELECT count(*) FROM price_observations o
              JOIN products p ON p.id = o.product_id
             WHERE p.store_id = %s AND o.observed_on = %s
        """,
            (store_id, DAY),
        )
        assert cur.fetchone()[0] == 50


def test_a_same_day_rerun_never_overwrites_a_price(conn) -> None:
    """The guarantee the entire project rests on."""
    store_id = db.resolve_store_id(conn, "nofrills", "3131")
    db.write_store_observations(conn, store_id, [make_row(i) for i in range(20)], DAY)

    # Same products, same day, different prices.
    changed = [make_row(i, price_cents=999) for i in range(20)]
    result = db.write_store_observations(conn, store_id, changed, DAY)

    assert result.observations_inserted == 0
    assert result.observations_already_present == 20

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT o.price_cents FROM price_observations o
              JOIN products p ON p.id = o.product_id
             WHERE p.store_id = %s AND o.observed_on = %s
        """,
            (store_id, DAY),
        )
        assert [r[0] for r in cur.fetchall()] == [500], "a historical price was overwritten"


def test_a_later_day_appends(conn) -> None:
    store_id = db.resolve_store_id(conn, "nofrills", "3131")
    db.write_store_observations(conn, store_id, [make_row(i) for i in range(20)], DAY)

    result = db.write_store_observations(
        conn, store_id, [make_row(i, price_cents=999) for i in range(20)], date(2026, 9, 22)
    )

    assert result.observations_inserted == 20
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.observed_on, o.price_cents FROM price_observations o
              JOIN products p ON p.id = o.product_id
             WHERE p.store_id = %s AND p.retailer_sku = %s ORDER BY o.observed_on
        """,
            (store_id, "SKU000001_EA"),
        )
        assert cur.fetchall() == [(DAY, 500), (date(2026, 9, 22), 999)]


def test_product_metadata_is_refreshed_on_a_later_run(conn) -> None:
    """Names get re-worded upstream; identity is not history."""
    store_id = db.resolve_store_id(conn, "nofrills", "3131")
    db.write_store_observations(conn, store_id, [make_row(1)], DAY)

    renamed = make_row(1)
    object.__setattr__(renamed, "raw_name", "2% Milk, Partly Skimmed")
    db.write_store_observations(conn, store_id, [renamed], date(2026, 9, 22))

    with conn.cursor() as cur:
        cur.execute(
            "SELECT raw_name FROM products WHERE store_id = %s AND retailer_sku = %s",
            (store_id, "SKU000001_EA"),
        )
        assert cur.fetchone()[0] == "2% Milk, Partly Skimmed"


def test_duplicate_skus_in_one_batch_do_not_abort_the_statement(conn) -> None:
    """ON CONFLICT DO UPDATE cannot touch the same row twice in one statement."""
    store_id = db.resolve_store_id(conn, "nofrills", "3131")

    result = db.write_store_observations(
        conn, store_id, [make_row(1), make_row(1), make_row(2)], DAY
    )

    assert result.errors == []
    assert result.products_written == 2


def test_a_batch_larger_than_one_chunk_is_written_whole(conn) -> None:
    store_id = db.resolve_store_id(conn, "nofrills", "3131")
    count = db.CHUNK_SIZE + 250

    result = db.write_store_observations(conn, store_id, [make_row(i) for i in range(count)], DAY)

    assert result.errors == []
    assert result.observations_inserted == count


def test_a_write_is_a_handful_of_round_trips_not_two_per_product(conn) -> None:
    """The reason for batching: 16 minutes of round trips nearly timed out a run."""
    store_id = db.resolve_store_id(conn, "nofrills", "3131")
    rows = [make_row(i) for i in range(500)]

    calls = 0
    original = psycopg.Cursor.execute

    def counting(self, *args, **kwargs):
        nonlocal calls
        calls += 1
        return original(self, *args, **kwargs)

    psycopg.Cursor.execute = counting
    try:
        db.write_store_observations(conn, store_id, rows, DAY)
    finally:
        psycopg.Cursor.execute = original

    assert calls <= 10, f"{calls} round trips for 500 products; row-at-a-time would be 1000"
