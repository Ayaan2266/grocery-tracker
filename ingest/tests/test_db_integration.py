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
from dataclasses import replace
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


SPANS_MIGRATION = "0006_store_price_changes_only.sql"


def apply_migrations(connection, *, before: str | None = None) -> None:
    """Apply migrations in order, stopping short of `before` if given."""
    with connection.cursor() as cur:
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if before is not None and path.name >= before:
                break
            cur.execute(path.read_text(encoding="utf-8"))
    connection.commit()


@pytest.fixture
def schema_conn():
    """A connection whose search_path points at a fresh, disposable schema."""
    schema = f"ingest_test_{uuid.uuid4().hex[:12]}"
    connection = psycopg.connect(DATABASE_URL, autocommit=False)
    try:
        with connection.cursor() as cur:
            cur.execute(f'CREATE SCHEMA "{schema}"')
            # public and extensions come along because pg_trgm's operator
            # class lives in whichever of them the host installed it into:
            # `extensions` on Supabase, `public` on a plain Postgres. The
            # migration deliberately does not qualify it for that reason.
            cur.execute(f'SET search_path TO "{schema}", public, extensions')
        connection.commit()
        yield connection
    finally:
        connection.rollback()
        with connection.cursor() as cur:
            cur.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        connection.commit()
        connection.close()


@pytest.fixture
def conn(schema_conn):
    # Every migration in order, so a new one is exercised here the day it
    # lands rather than the day it breaks production.
    apply_migrations(schema_conn)
    return schema_conn


def make_row(
    index: int, price_cents: int = 500, *, in_stock: bool | None = None
) -> NormalizedPrice:
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
        in_stock=index % 10 != 0 if in_stock is None else in_stock,
    )


def history(conn, retailer_sku: str, store_code: str = "3131") -> list[tuple[date, int]]:
    """One product's rebuilt daily series from the price_observations view."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.observed_on, o.price_cents
              FROM price_observations o
              JOIN products p ON p.id = o.product_id
              JOIN stores s   ON s.id = p.store_id
             WHERE p.retailer_sku = %s AND s.store_code = %s
             ORDER BY o.observed_on
            """,
            (retailer_sku, store_code),
        )
        return cur.fetchall()


def spans(conn, retailer_sku: str, store_code: str = "3131") -> list[tuple[date, date, int]]:
    """One product's stored rows."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT ps.first_observed_on, ps.last_confirmed_on, ps.price_cents
              FROM price_spans ps
              JOIN products p ON p.id = ps.product_id
              JOIN stores s   ON s.id = p.store_id
             WHERE p.retailer_sku = %s AND s.store_code = %s
             ORDER BY ps.first_observed_on
            """,
            (retailer_sku, store_code),
        )
        return cur.fetchall()


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
    assert result.observations_recorded == 50
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

    assert result.observations_recorded == 0
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

    assert result.observations_recorded == 20
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
    assert result.observations_recorded == count


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


class TestRowLevelSecurity:
    """The anon key ships to every browser, so anything it can do, anyone can.

    web/src/lib/supabase.ts describes this security model in a comment. These
    tests are what make the comment true rather than aspirational.
    """

    def test_anon_can_read_every_table(self, conn) -> None:
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], DAY)

        with conn.cursor() as cur:
            cur.execute("SET LOCAL ROLE anon")
            for table in (
                "retailers",
                "stores",
                "products",
                "price_spans",
                "ingest_runs",
                "price_observations",
            ):
                cur.execute(f"SELECT count(*) FROM {table}")
                assert cur.fetchone()[0] > 0, f"anon cannot read {table}"

    def test_anon_cannot_insert(self, conn) -> None:
        with conn.cursor() as cur:
            cur.execute("SET LOCAL ROLE anon")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                cur.execute(
                    "INSERT INTO retailers (name, banner_slug, parent_company)"
                    " VALUES ('x', 'x', 'x')"
                )

    @pytest.mark.parametrize(
        "statement",
        [
            "UPDATE price_spans SET price_cents = 1",
            "UPDATE price_spans SET last_confirmed_on = last_confirmed_on + 1",
            "UPDATE ingest_runs SET products_observed = 0",
        ],
    )
    def test_anon_cannot_rewrite_a_price(self, conn, statement: str) -> None:
        """The one thing in the project that cannot be regenerated."""
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], DAY)

        with conn.cursor() as cur:
            cur.execute("SET LOCAL ROLE anon")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                cur.execute(statement)

    @pytest.mark.parametrize("table", ["price_spans", "ingest_runs"])
    def test_anon_cannot_delete_history(self, conn, table: str) -> None:
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], DAY)

        with conn.cursor() as cur:
            cur.execute("SET LOCAL ROLE anon")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                cur.execute(f"DELETE FROM {table}")

    def test_the_daily_view_cannot_be_written_through(self, conn) -> None:
        """price_observations is a view now; a write through it has nowhere to go."""
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], DAY)

        with conn.cursor() as cur, pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
            cur.execute("UPDATE price_observations SET price_cents = 1")

    def test_rls_is_enabled_on_every_table(self, conn) -> None:
        """A table with RLS off is readable and writable by anyone granted it."""
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT tablename, rowsecurity FROM pg_tables
                 WHERE schemaname = current_schema()
                 ORDER BY tablename
                """
            )
            rows = dict(cur.fetchall())

        assert rows, "no tables found in the test schema"
        assert all(rows.values()), f"RLS off on: {[t for t, on in rows.items() if not on]}"

    def test_the_owner_still_writes(self, conn) -> None:
        """Ingestion connects as the owner, which bypasses RLS by design."""
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        result = db.write_store_observations(conn, store_id, [make_row(1)], DAY)
        assert result.errors == []
        assert result.observations_recorded == 1


class TestViews:
    """The views the frontend reads: 0004, repointed at price_spans by 0006."""

    def test_latest_price_returns_one_row_per_product(self, conn) -> None:
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        rows = [make_row(i) for i in range(10)]
        db.write_store_observations(conn, store_id, rows, DAY)
        db.write_store_observations(
            conn,
            store_id,
            [make_row(i, price_cents=999) for i in range(10)],
            date(2026, 9, 22),
        )

        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM product_latest_price")
            assert cur.fetchone()[0] == 10, "one row per product, not per observation"

    def test_latest_price_carries_the_newest_observation(self, conn) -> None:
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], DAY)
        db.write_store_observations(
            conn, store_id, [make_row(1, price_cents=999)], date(2026, 9, 22)
        )

        with conn.cursor() as cur:
            cur.execute(
                "SELECT observed_on, price_cents FROM product_latest_price WHERE retailer_sku = %s",
                ("SKU000001_EA",),
            )
            assert cur.fetchone() == (date(2026, 9, 22), 999)

    def test_latest_price_joins_the_banner_through(self, conn) -> None:
        store_id = db.resolve_store_id(conn, "loblaw", "1032")
        db.write_store_observations(conn, store_id, [make_row(1)], DAY)

        with conn.cursor() as cur:
            cur.execute(
                "SELECT banner_slug, store_code FROM product_latest_price WHERE retailer_sku = %s",
                ("SKU000001_EA",),
            )
            assert cur.fetchone() == ("loblaw", "1032")

    def test_coverage_counts_days_not_rows(self, conn) -> None:
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        for day in (DAY, date(2026, 9, 22), date(2026, 9, 23)):
            db.write_store_observations(conn, store_id, [make_row(i) for i in range(4)], day)

        with conn.cursor() as cur:
            cur.execute(
                "SELECT products, observations, days, first_day, last_day FROM ingest_coverage"
            )
            products, observations, days, first_day, last_day = cur.fetchone()

        assert (products, observations, days) == (4, 12, 3)
        assert (first_day, last_day) == (DAY, date(2026, 9, 23))

    def test_coverage_agrees_with_the_rebuilt_daily_series(self, conn) -> None:
        """observations is summed from ingest_runs, so it must match what the view expands to."""
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(i) for i in range(10)], DAY)
        # A same-day re-run that finds five more products than the first run did.
        db.write_store_observations(conn, store_id, [make_row(i) for i in range(15)], DAY)
        db.write_store_observations(
            conn, store_id, [make_row(i, price_cents=600) for i in range(12)], date(2026, 9, 22)
        )

        with conn.cursor() as cur:
            cur.execute("SELECT observations FROM ingest_coverage")
            observations = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM price_observations")
            assert observations == cur.fetchone()[0] == 15 + 12

    def test_both_views_run_as_the_invoker(self, conn) -> None:
        """Without security_invoker a view runs as its owner and bypasses RLS.

        The owner here is the role that writes the data, so the view would be a
        hole straight through every policy 0003 added.
        """
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT c.relname, c.reloptions
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = current_schema()
                   AND c.relkind = 'v'
                 ORDER BY c.relname
                """
            )
            views = dict(cur.fetchall())

        assert set(views) == {"ingest_coverage", "price_observations", "product_latest_price"}
        for name, options in views.items():
            assert options and "security_invoker=true" in options, (
                f"{name} does not run as the invoker"
            )

    def test_anon_can_read_every_view(self, conn) -> None:
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], DAY)

        with conn.cursor() as cur:
            cur.execute("SET LOCAL ROLE anon")
            cur.execute("SELECT count(*) FROM product_latest_price")
            assert cur.fetchone()[0] == 1
            cur.execute("SELECT products FROM ingest_coverage")
            assert cur.fetchone()[0] == 1
            cur.execute("SELECT count(*) FROM price_observations")
            assert cur.fetchone()[0] == 1

    def test_latest_price_narrows_products_before_reading_prices(self, conn) -> None:
        """A search must not read every span ever stored.

        0004's DISTINCT ON could not push the search filter beneath it, so each
        search read the whole history table. The LATERAL form reads one span
        per matching product, through the primary key.
        """
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(i) for i in range(50)], DAY)

        with conn.cursor() as cur:
            cur.execute("SET LOCAL enable_seqscan = off")
            cur.execute(
                "EXPLAIN SELECT * FROM product_latest_price WHERE raw_name ILIKE %s",
                ("%Product 7%",),
            )
            plan = "\n".join(row[0] for row in cur.fetchall())

        # The search narrows products first, then looks up one span per match.
        # 0004's shape joined every span and filtered afterwards, so neither
        # line appears in its plan.
        assert "idx_products_raw_name_trgm" in plan
        assert "Index Cond: (product_id = p.id)" in plan


class TestPriceSpans:
    """Storing changes only, 0006. The daily series must come back exactly."""

    D1, D2, D3, D4 = (date(2026, 9, d) for d in (21, 22, 23, 24))

    def test_an_unchanged_price_extends_one_row(self, conn) -> None:
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        results = [
            db.write_store_observations(conn, store_id, [make_row(i) for i in range(5)], day)
            for day in (self.D1, self.D2, self.D3)
        ]

        assert [r.observations_recorded for r in results] == [5, 5, 5]
        assert [r.spans_opened for r in results] == [5, 0, 0]
        assert spans(conn, "SKU000001_EA") == [(self.D1, self.D3, 500)]
        assert history(conn, "SKU000001_EA") == [(self.D1, 500), (self.D2, 500), (self.D3, 500)]

    def test_a_changed_price_opens_a_new_row(self, conn) -> None:
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], self.D1)
        result = db.write_store_observations(conn, store_id, [make_row(1, 450)], self.D2)

        assert result.spans_opened == 1
        assert spans(conn, "SKU000001_EA") == [(self.D1, self.D1, 500), (self.D2, self.D2, 450)]

    def test_any_changed_value_counts_as_a_change(self, conn) -> None:
        """Going out of stock at the same price is still history worth keeping."""
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1, in_stock=True)], self.D1)
        db.write_store_observations(conn, store_id, [make_row(1, in_stock=False)], self.D2)

        assert len(spans(conn, "SKU000001_EA")) == 2

    def test_a_price_that_returns_is_not_merged_across_the_change(self, conn) -> None:
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        for day, price in ((self.D1, 500), (self.D2, 399), (self.D3, 500)):
            db.write_store_observations(conn, store_id, [make_row(1, price)], day)

        assert history(conn, "SKU000001_EA") == [(self.D1, 500), (self.D2, 399), (self.D3, 500)]
        assert len(spans(conn, "SKU000001_EA")) == 3

    def test_a_product_missing_from_a_run_is_not_reported_that_day(self, conn) -> None:
        """Unchanged and unobserved are different things. The store ran on D2
        without seeing products 5-9, so D2 must not appear in their history."""
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(i) for i in range(10)], self.D1)
        db.write_store_observations(conn, store_id, [make_row(i) for i in range(5)], self.D2)
        db.write_store_observations(conn, store_id, [make_row(i) for i in range(10)], self.D3)

        assert history(conn, "SKU000007_EA") == [(self.D1, 500), (self.D3, 500)]
        assert spans(conn, "SKU000007_EA") == [(self.D1, self.D1, 500), (self.D3, self.D3, 500)]
        # Seen every night: still one row.
        assert spans(conn, "SKU000002_EA") == [(self.D1, self.D3, 500)]

    def test_a_night_a_store_did_not_run_is_bridged_but_not_claimed(self, conn) -> None:
        """A failed night leaves no ingest_runs row for that store, so one row can
        cover it and the rebuilt series still skips it. Runs are per store:
        another store running on D2 must not make this one's D2 appear."""
        nofrills = db.resolve_store_id(conn, "nofrills", "3131")
        superstore = db.resolve_store_id(conn, "superstore", "1516")
        for day in (self.D1, self.D2, self.D3):
            db.write_store_observations(conn, nofrills, [make_row(1)], day)
        for day in (self.D1, self.D3):
            db.write_store_observations(conn, superstore, [make_row(1)], day)

        assert spans(conn, "SKU000001_EA", "1516") == [(self.D1, self.D3, 500)]
        assert history(conn, "SKU000001_EA", "1516") == [(self.D1, 500), (self.D3, 500)]

    def test_a_same_day_rerun_with_the_previous_price_does_not_overlap_rows(self, conn) -> None:
        """D2's first write opened a row at 450. A re-run that sees yesterday's
        500 again must not stretch the D1 row over the D2 one."""
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], self.D1)
        db.write_store_observations(conn, store_id, [make_row(1, 450)], self.D2)
        rerun = db.write_store_observations(conn, store_id, [make_row(1)], self.D2)

        assert rerun.observations_already_present == 1
        assert spans(conn, "SKU000001_EA") == [(self.D1, self.D1, 500), (self.D2, self.D2, 450)]

    def test_a_same_day_rerun_leaves_an_extended_row_as_written(self, conn) -> None:
        """D2 extended the D1 row. A re-run on D2 that sees a different price
        must neither overwrite D2 nor open a second row covering D2."""
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], self.D1)
        db.write_store_observations(conn, store_id, [make_row(1)], self.D2)
        rerun = db.write_store_observations(conn, store_id, [make_row(1, 450)], self.D2)

        assert rerun.observations_already_present == 1
        assert spans(conn, "SKU000001_EA") == [(self.D1, self.D2, 500)]
        assert history(conn, "SKU000001_EA") == [(self.D1, 500), (self.D2, 500)]

    def test_an_empty_batch_records_no_run(self, conn) -> None:
        """A store that returned nothing is a failed fetch, not a night on which
        every product vanished, so it must not split every span in the store."""
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], self.D1)
        db.write_store_observations(conn, store_id, [], self.D2)
        db.write_store_observations(conn, store_id, [make_row(1)], self.D3)

        assert spans(conn, "SKU000001_EA") == [(self.D1, self.D3, 500)]
        assert history(conn, "SKU000001_EA") == [(self.D1, 500), (self.D3, 500)]

    def test_a_day_before_the_latest_run_is_refused(self, conn) -> None:
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        db.write_store_observations(conn, store_id, [make_row(1)], self.D2)

        result = db.write_store_observations(conn, store_id, [make_row(1, 450)], self.D1)

        assert result.errors and "forward only" in result.errors[0]
        assert history(conn, "SKU000001_EA") == [(self.D2, 500)]

    def test_a_steady_week_costs_one_row_per_product(self, conn) -> None:
        """The point of the change: 17,500 rows a night was ~2.9 MB a night."""
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        week = [date(2026, 9, 21 + offset) for offset in range(7)]
        for day in week:
            db.write_store_observations(conn, store_id, [make_row(i) for i in range(100)], day)

        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM price_spans")
            assert cur.fetchone()[0] == 100
            cur.execute("SELECT count(*) FROM price_observations")
            assert cur.fetchone()[0] == 700


class TestAppendOnly:
    """The trigger from 0006. It binds the owner too, which is what ingestion runs as."""

    @pytest.fixture
    def written(self, conn):
        store_id = db.resolve_store_id(conn, "nofrills", "3131")
        for day in (date(2026, 9, 21), date(2026, 9, 22), date(2026, 9, 23)):
            db.write_store_observations(conn, store_id, [make_row(1)], day)
        return conn

    @pytest.mark.parametrize(
        "statement",
        [
            "UPDATE price_spans SET price_cents = 1",
            "UPDATE price_spans SET was_price_cents = 1",
            "UPDATE price_spans SET first_observed_on = first_observed_on - 1",
            "UPDATE price_spans SET last_confirmed_on = last_confirmed_on - 1",
            "DELETE FROM price_spans",
            "TRUNCATE price_spans",
        ],
    )
    def test_the_owner_cannot_rewrite_history(self, written, statement: str) -> None:
        with written.cursor() as cur, pytest.raises(psycopg.errors.RaiseException):
            cur.execute(statement)

    def test_the_owner_can_move_a_confirmation_forward(self, written) -> None:
        """The one UPDATE the nightly write needs."""
        with written.cursor() as cur:
            cur.execute("UPDATE price_spans SET last_confirmed_on = last_confirmed_on + 1")
            assert cur.rowcount == 1


class TestSpansBackfill:
    """0006 converts the daily table already in Supabase. Checked on a copy.

    D1-D4: nofrills ran every night. Superstore's D3 failed, so it has no rows
    that night. Each product exercises one rule of the conversion.
    """

    D1, D2, D3, D4 = (date(2026, 9, d) for d in (21, 22, 23, 24))

    DAILY = {
        # sku: (store_code, {day: (price_cents, in_stock)})
        "STEADY_EA": ("3131", {21: (500, True), 22: (500, True), 23: (500, True), 24: (500, True)}),
        "DIPS_EA": ("3131", {21: (500, True), 22: (500, True), 23: (450, True), 24: (500, True)}),
        "GAP_EA": ("3131", {21: (300, True), 23: (300, True), 24: (300, True)}),
        "STOCK_EA": ("3131", {21: (200, True), 22: (200, False), 23: (200, False)}),
        "FAILED_NIGHT_EA": ("1516", {21: (700, True), 22: (700, True), 24: (700, True)}),
    }

    EXPECTED_SPANS = {
        "STEADY_EA": [(D1, D4, 500)],
        "DIPS_EA": [(D1, D2, 500), (D3, D3, 450), (D4, D4, 500)],
        "GAP_EA": [(D1, D1, 300), (D3, D4, 300)],
        "STOCK_EA": [(D1, D1, 200), (D2, D3, 200)],
        "FAILED_NIGHT_EA": [(D1, D4, 700)],
    }

    @pytest.fixture
    def migrated(self, schema_conn):
        apply_migrations(schema_conn, before=SPANS_MIGRATION)
        with schema_conn.cursor() as cur:
            for sku, (store_code, days) in self.DAILY.items():
                cur.execute(
                    """
                    INSERT INTO products (store_id, retailer_sku, raw_name)
                    SELECT id, %s, %s FROM stores WHERE store_code = %s
                    RETURNING id
                    """,
                    (sku, sku, store_code),
                )
                product_id = cur.fetchone()[0]
                for day, (price_cents, in_stock) in days.items():
                    cur.execute(
                        """
                        INSERT INTO price_observations
                            (product_id, price_cents, comparison_unit, comparison_quantity,
                             unit_price_source, in_stock, observed_on)
                        VALUES (%s, %s, NULL, NULL, 'none', %s, %s)
                        """,
                        (product_id, price_cents, in_stock, date(2026, 9, day)),
                    )
            # Every nofrills product is absent from superstore and vice versa,
            # so "the store ran" is exactly "some product has a row that night".
        schema_conn.commit()

        with schema_conn.cursor() as cur:
            cur.execute((MIGRATIONS / SPANS_MIGRATION).read_text(encoding="utf-8"))
        schema_conn.commit()
        return schema_conn

    def test_daily_rows_become_the_expected_spans(self, migrated) -> None:
        actual = {
            sku: spans(migrated, sku, store_code) for sku, (store_code, _days) in self.DAILY.items()
        }
        assert actual == self.EXPECTED_SPANS

    def test_every_store_day_becomes_a_run(self, migrated) -> None:
        with migrated.cursor() as cur:
            cur.execute(
                """
                SELECT s.store_code, r.run_on, r.products_observed
                  FROM ingest_runs r JOIN stores s ON s.id = r.store_id
                 ORDER BY s.store_code, r.run_on
                """
            )
            assert cur.fetchall() == [
                ("1516", self.D1, 1),
                ("1516", self.D2, 1),
                ("1516", self.D4, 1),
                ("3131", self.D1, 4),
                ("3131", self.D2, 3),
                ("3131", self.D3, 4),
                ("3131", self.D4, 3),
            ]

    def test_the_view_rebuilds_the_original_table_exactly(self, migrated) -> None:
        columns = (
            "product_id, price_cents, was_price_cents, unit_price_cents, comparison_unit,"
            " comparison_quantity, unit_price_source, in_stock, observed_on"
        )
        with migrated.cursor() as cur:
            cur.execute(f"SELECT {columns} FROM price_observations_daily_v1 ORDER BY 1, 9")
            original = cur.fetchall()
            cur.execute(f"SELECT {columns} FROM price_observations ORDER BY 1, 9")
            assert cur.fetchall() == original
        assert len(original) == sum(len(days) for _store, days in self.DAILY.values())

    def test_the_archive_is_closed_to_the_public_api(self, migrated) -> None:
        with migrated.cursor() as cur:
            cur.execute("SET LOCAL ROLE anon")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                cur.execute("SELECT count(*) FROM price_observations_daily_v1")

    def test_the_next_night_continues_converted_history(self, migrated) -> None:
        """Converted spans and nightly writes follow the same rule, so the first
        run after the migration extends what the migration built."""
        superstore = db.resolve_store_id(migrated, "superstore", "1516")
        # The values the backfill fixture stored for this product on D4.
        row = replace(
            make_row(0, 700, in_stock=True),
            retailer_sku="FAILED_NIGHT_EA",
            raw_name="FAILED_NIGHT_EA",
            was_price_cents=None,
        )

        result = db.write_store_observations(migrated, superstore, [row], date(2026, 9, 25))

        assert result.errors == []
        assert result.spans_opened == 0
        assert spans(migrated, "FAILED_NIGHT_EA", "1516") == [(self.D1, date(2026, 9, 25), 700)]
