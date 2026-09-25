"""Database writes.

No price is ever rewritten. Prices live in `price_spans`, one row per unbroken
stretch of identical values, because storing every product every night filled
the free tier in months (see db/migrations/0006). Each night, for each
product, exactly one of three things happens:

  present   its latest span already covers today: this is a same-day re-run,
            and the first write stands exactly as it was written.
  extend    its latest span was confirmed on this store's previous run and
            today's values are identical: last_confirmed_on moves to today.
  open      anything else -- a new product, a changed value, or a product the
            previous run did not see: a new span starting today.

The "previous run" condition is what keeps "unchanged" distinct from "not
observed". A span never stretches across a run that happened without the
product in it, and `ingest_runs` records which runs happened.

The one UPDATE issued against `price_spans` sets last_confirmed_on. A trigger
in 0006 rejects any other UPDATE, any backwards move, and any DELETE, from
every role, so this is enforced by Postgres and not only by this module.

`products` is the deliberate exception and upserts on (store_id, retailer_sku)
with DO UPDATE. Names and package sizes get re-worded upstream and the newest
rendering is the one worth keeping. Identity is not history.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date

import psycopg

from ingest.match import keys
from ingest.normalize import NormalizedPrice

log = logging.getLogger(__name__)


class UnknownStore(RuntimeError):
    """A targets.json store has no matching row in the `stores` table."""


class SchemaOutOfDate(RuntimeError):
    """The database is missing a column this code writes: a migration is unapplied."""


RESOLVE_STORE = """
SELECT s.id
  FROM stores s
  JOIN retailers r ON r.id = s.retailer_id
 WHERE r.banner_slug = %s
   AND s.store_code = %s
   AND s.active
"""

# Rows per round trip. A night is several thousand products per store; sending
# them one at a time meant ~13,000 sequential round trips to ca-central-1 and a
# 16-minute write phase against a 30-minute job timeout. unnest() turns each
# chunk into a single statement.
CHUNK_SIZE = 1000

# identity_key and substitute_key are ingest/match.py's reading of the same
# name, brand and package, so they are refreshed along with them.
UPSERT_PRODUCTS = """
INSERT INTO products (
    store_id, retailer_sku, raw_name, brand, package_size, size_value, size_unit,
    identity_key, substitute_key
)
SELECT %(store_id)s, u.sku, u.name, u.brand, u.pkg, u.size_value, u.size_unit,
       u.identity_key, u.substitute_key
  FROM unnest(
           %(skus)s::text[], %(names)s::text[], %(brands)s::text[],
           %(pkgs)s::text[], %(size_values)s::numeric[], %(size_units)s::text[],
           %(identity_keys)s::text[], %(substitute_keys)s::text[]
       ) AS u(sku, name, brand, pkg, size_value, size_unit, identity_key, substitute_key)
ON CONFLICT (store_id, retailer_sku) DO UPDATE
   SET raw_name       = EXCLUDED.raw_name,
       brand          = EXCLUDED.brand,
       package_size   = EXCLUDED.package_size,
       size_value     = EXCLUDED.size_value,
       size_unit      = EXCLUDED.size_unit,
       identity_key   = EXCLUDED.identity_key,
       substitute_key = EXCLUDED.substitute_key
RETURNING retailer_sku, id
"""

# The newest columns the writes depend on. Selecting them costs nothing and
# fails with the column's name when a migration has not been applied.
SCHEMA_CHECK = "SELECT identity_key, substitute_key FROM products LIMIT 0"

RUN_DATES = """
SELECT max(run_on) FILTER (WHERE run_on < %(observed_on)s),
       max(run_on)
  FROM ingest_runs
 WHERE store_id = %(store_id)s
"""

# One statement per chunk. `classified` pairs each incoming row with its
# product's latest span and decides present / extend / open, the table in the
# module docstring. Both writes then read that one decision, and every CTE sees
# the same snapshot, so a row cannot be extended and opened at once.
WRITE_SPANS = """
WITH incoming AS (
    SELECT *
      FROM unnest(
               %(product_ids)s::int[], %(price_cents)s::int[], %(was_price_cents)s::int[],
               %(unit_price_cents)s::int[], %(comparison_units)s::text[],
               %(comparison_quantities)s::numeric[], %(unit_price_sources)s::text[],
               %(in_stocks)s::boolean[], %(implied_regular_cents)s::int[]
           ) AS u(product_id, price_cents, was_price_cents, unit_price_cents,
                  comparison_unit, comparison_quantity, unit_price_source, in_stock,
                  implied_regular_cents)
),
classified AS (
    SELECT i.*,
           latest.first_observed_on AS span_start,
           CASE
               WHEN latest.last_confirmed_on >= %(observed_on)s THEN 'present'
               WHEN latest.last_confirmed_on = %(previous_run_on)s
                AND ROW(latest.price_cents, latest.was_price_cents, latest.unit_price_cents,
                        latest.comparison_unit, latest.comparison_quantity,
                        latest.unit_price_source, latest.in_stock,
                        latest.implied_regular_cents)
                    IS NOT DISTINCT FROM
                    ROW(i.price_cents, i.was_price_cents, i.unit_price_cents,
                        i.comparison_unit, i.comparison_quantity,
                        i.unit_price_source, i.in_stock, i.implied_regular_cents)
                   THEN 'extend'
               ELSE 'open'
           END AS action
      FROM incoming i
      LEFT JOIN LATERAL (
               SELECT *
                 FROM price_spans s
                WHERE s.product_id = i.product_id
                ORDER BY s.first_observed_on DESC
                LIMIT 1
           ) latest ON true
),
extended AS (
    UPDATE price_spans s
       SET last_confirmed_on = %(observed_on)s
      FROM classified c
     WHERE c.action = 'extend'
       AND s.product_id = c.product_id
       AND s.first_observed_on = c.span_start
    RETURNING 1
),
opened AS (
    INSERT INTO price_spans (
        product_id, first_observed_on, last_confirmed_on, price_cents, was_price_cents,
        unit_price_cents, comparison_unit, comparison_quantity, unit_price_source, in_stock,
        implied_regular_cents
    )
    SELECT c.product_id, %(observed_on)s, %(observed_on)s, c.price_cents, c.was_price_cents,
           c.unit_price_cents, c.comparison_unit, c.comparison_quantity,
           c.unit_price_source, c.in_stock, c.implied_regular_cents
      FROM classified c
     WHERE c.action = 'open'
    ON CONFLICT (product_id, first_observed_on) DO NOTHING
    RETURNING 1
)
SELECT (SELECT count(*) FROM extended), (SELECT count(*) FROM opened)
"""

# Recorded in the same transaction as the spans, so a store-day is in
# ingest_runs if and only if its prices are. A same-day re-run adds only the
# products it observed that the first run had not.
RECORD_RUN = """
INSERT INTO ingest_runs (store_id, run_on, products_observed)
VALUES (%(store_id)s, %(observed_on)s, %(products_observed)s)
ON CONFLICT (store_id, run_on) DO UPDATE
   SET products_observed = ingest_runs.products_observed + EXCLUDED.products_observed
"""


@dataclass
class WriteResult:
    products_written: int = 0
    # Product-days newly recorded: extended spans plus opened ones.
    observations_recorded: int = 0
    observations_already_present: int = 0
    # The part of observations_recorded that needed a new row: new products,
    # changed values, and products back after a run without them. Everything
    # else cost an UPDATE of one date.
    spans_opened: int = 0
    errors: list[str] = field(default_factory=list)

    def merge(self, other: WriteResult) -> None:
        self.products_written += other.products_written
        self.observations_recorded += other.observations_recorded
        self.observations_already_present += other.observations_already_present
        self.spans_opened += other.spans_opened
        self.errors.extend(other.errors)


def connect(database_url: str) -> psycopg.Connection:
    """Open a connection with autocommit off; each store commits as a unit.

    prepare_threshold=None turns off psycopg's automatic prepared statements,
    which default to kicking in after a statement has run 5 times. A night
    runs the two statements below once per product -- several hundred times --
    so they would certainly be prepared.

    DATABASE_URL points at Supabase's transaction-mode pooler (port 6543), and
    a server-side prepared statement is bound to one backend connection while
    the pooler hands out a different one per transaction. That mismatch
    surfaces as "prepared statement already exists" partway through a run, at
    3am, after some rows are already committed. Newer Supavisor builds handle
    named prepared statements, but this is a nightly batch job where the cost
    of not preparing is unmeasurable, so there is no reason to depend on it.
    """
    return psycopg.connect(database_url, autocommit=False, prepare_threshold=None)


def check_schema(conn: psycopg.Connection) -> None:
    """Raise SchemaOutOfDate unless every column the writes use exists."""
    try:
        conn.execute(SCHEMA_CHECK)
    except psycopg.errors.UndefinedColumn as exc:
        conn.rollback()
        raise SchemaOutOfDate(
            f"{exc.diag.message_primary}. Apply db/migrations/0009_product_match_keys.sql "
            "(and any other migration not yet applied) before running this code."
        ) from exc


def resolve_store_id(conn: psycopg.Connection, banner_slug: str, store_code: str) -> int:
    row = conn.execute(RESOLVE_STORE, (banner_slug, store_code)).fetchone()
    if row is None:
        raise UnknownStore(
            f"no active store for banner={banner_slug} store_code={store_code}. "
            "Add it in a migration before adding it to targets.json."
        )
    return int(row[0])


def write_store_observations(
    conn: psycopg.Connection,
    store_id: int,
    rows: list[NormalizedPrice],
    observed_on: date,
) -> WriteResult:
    """Write one store's results in a single transaction.

    Committed per store so that a failure partway through the night leaves
    whole stores written rather than a half-written one.

    Rows go up in chunks of CHUNK_SIZE via unnest(), two statements per chunk,
    rather than two per product. On 2026-09-21 the row-at-a-time version spent
    16 minutes writing 19,742 observations and finished four minutes inside a
    30-minute job timeout; a busier day would have lost the night's history.

    Days are written forward only. Extending a span assumes nothing has been
    written after `observed_on`, so a day older than this store's latest run
    is refused rather than spliced into the middle of its history.
    """
    result = WriteResult()

    # ON CONFLICT DO UPDATE cannot touch the same row twice in one statement,
    # so a duplicate SKU inside a chunk would abort it. run.py already collapses
    # by SKU; this makes the guarantee local to the function that depends on it.
    deduped = {row.retailer_sku: row for row in rows}
    batch = list(deduped.values())

    # Recording a run that saw nothing would tell tomorrow's write that every
    # product went missing tonight, and split every span in the store. An empty
    # store is a failed fetch (run.py never passes one), not an observation.
    if not batch:
        return result

    try:
        with conn.cursor() as cur:
            cur.execute(RUN_DATES, {"store_id": store_id, "observed_on": observed_on})
            previous_run_on, latest_run_on = cur.fetchone()
            if latest_run_on is not None and latest_run_on > observed_on:
                conn.rollback()
                result.errors.append(
                    f"store_id={store_id}: refusing to write {observed_on}, this store's "
                    f"history already reaches {latest_run_on}. Days are written forward only."
                )
                log.error("%s", result.errors[-1])
                return result

            for start in range(0, len(batch), CHUNK_SIZE):
                chunk = batch[start : start + CHUNK_SIZE]

                match_keys = [keys(r.brand, r.raw_name, r.package_size) for r in chunk]
                cur.execute(
                    UPSERT_PRODUCTS,
                    {
                        "store_id": store_id,
                        "skus": [r.retailer_sku for r in chunk],
                        "names": [r.raw_name for r in chunk],
                        "brands": [r.brand for r in chunk],
                        "pkgs": [r.package_size for r in chunk],
                        "size_values": [r.size_value for r in chunk],
                        "size_units": [r.size_unit for r in chunk],
                        "identity_keys": [identity for identity, _ in match_keys],
                        "substitute_keys": [substitute for _, substitute in match_keys],
                    },
                )
                product_ids = {sku: pid for sku, pid in cur.fetchall()}
                result.products_written += len(product_ids)

                # A product whose upsert returned nothing has no id to hang an
                # observation on. RETURNING always yields on a conflict-update,
                # so this stays empty in practice.
                observed = [r for r in chunk if r.retailer_sku in product_ids]

                cur.execute(
                    WRITE_SPANS,
                    {
                        "observed_on": observed_on,
                        "previous_run_on": previous_run_on,
                        "product_ids": [product_ids[r.retailer_sku] for r in observed],
                        "price_cents": [r.price_cents for r in observed],
                        "was_price_cents": [r.was_price_cents for r in observed],
                        "unit_price_cents": [r.unit_price_cents for r in observed],
                        "comparison_units": [r.comparison_unit for r in observed],
                        "comparison_quantities": [r.comparison_quantity for r in observed],
                        "unit_price_sources": [r.unit_price_source for r in observed],
                        "in_stocks": [r.in_stock for r in observed],
                        "implied_regular_cents": [r.implied_regular_cents for r in observed],
                    },
                )
                extended, opened = cur.fetchone()
                # The rest were already confirmed today and were left exactly
                # as written -- the intended re-run behaviour.
                result.observations_recorded += extended + opened
                result.observations_already_present += len(observed) - extended - opened
                result.spans_opened += opened

            cur.execute(
                RECORD_RUN,
                {
                    "store_id": store_id,
                    "observed_on": observed_on,
                    "products_observed": result.observations_recorded,
                },
            )

        conn.commit()
    except psycopg.Error as exc:
        conn.rollback()
        result.errors.append(f"store_id={store_id}: {exc}")
        log.exception("write failed for store_id=%s, rolled back", store_id)

    return result
