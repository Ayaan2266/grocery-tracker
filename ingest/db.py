"""Database writes.

`price_observations` is APPEND-ONLY. Nothing in this module -- or anywhere in
the project -- issues an UPDATE or DELETE against it. It is the one asset a
competitor cannot retroactively reproduce, and a row rewritten is a day of
history gone for good.

There are two ON CONFLICT clauses here and they mean different things:

  products             (store_id, retailer_sku)   DO UPDATE
      Products are mutable metadata. Names and package sizes get re-worded
      upstream and the newest rendering is the one worth keeping.

  price_observations   (product_id, observed_on)  DO NOTHING
      Deliberately NOT DO UPDATE. Re-running a failed ingest on the same day
      is then idempotent: rows already written stay exactly as they were
      written. If a bad value lands, `unit_price_source` is there so it can be
      identified and corrected analytically later, rather than by silently
      overwriting history.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date

import psycopg

from ingest.normalize import NormalizedPrice

log = logging.getLogger(__name__)


class UnknownStore(RuntimeError):
    """A targets.json store has no matching row in the `stores` table."""


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

UPSERT_PRODUCTS = """
INSERT INTO products (
    store_id, retailer_sku, raw_name, brand, package_size, size_value, size_unit
)
SELECT %(store_id)s, u.sku, u.name, u.brand, u.pkg, u.size_value, u.size_unit
  FROM unnest(
           %(skus)s::text[], %(names)s::text[], %(brands)s::text[],
           %(pkgs)s::text[], %(size_values)s::numeric[], %(size_units)s::text[]
       ) AS u(sku, name, brand, pkg, size_value, size_unit)
ON CONFLICT (store_id, retailer_sku) DO UPDATE
   SET raw_name     = EXCLUDED.raw_name,
       brand        = EXCLUDED.brand,
       package_size = EXCLUDED.package_size,
       size_value   = EXCLUDED.size_value,
       size_unit    = EXCLUDED.size_unit
RETURNING retailer_sku, id
"""

INSERT_OBSERVATIONS = """
INSERT INTO price_observations (
    product_id, price_cents, was_price_cents, unit_price_cents,
    comparison_unit, comparison_quantity, unit_price_source, in_stock, observed_on
)
SELECT u.product_id, u.price_cents, u.was_price_cents, u.unit_price_cents,
       u.comparison_unit, u.comparison_quantity, u.unit_price_source, u.in_stock,
       %(observed_on)s
  FROM unnest(
           %(product_ids)s::int[], %(price_cents)s::int[], %(was_price_cents)s::int[],
           %(unit_price_cents)s::int[], %(comparison_units)s::text[],
           %(comparison_quantities)s::numeric[], %(unit_price_sources)s::text[],
           %(in_stocks)s::boolean[]
       ) AS u(product_id, price_cents, was_price_cents, unit_price_cents,
              comparison_unit, comparison_quantity, unit_price_source, in_stock)
ON CONFLICT (product_id, observed_on) DO NOTHING
"""


@dataclass
class WriteResult:
    products_written: int = 0
    observations_inserted: int = 0
    observations_already_present: int = 0
    errors: list[str] = field(default_factory=list)

    def merge(self, other: WriteResult) -> None:
        self.products_written += other.products_written
        self.observations_inserted += other.observations_inserted
        self.observations_already_present += other.observations_already_present
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
    """
    result = WriteResult()

    # ON CONFLICT DO UPDATE cannot touch the same row twice in one statement,
    # so a duplicate SKU inside a chunk would abort it. run.py already collapses
    # by SKU; this makes the guarantee local to the function that depends on it.
    deduped = {row.retailer_sku: row for row in rows}
    batch = list(deduped.values())

    try:
        with conn.cursor() as cur:
            for start in range(0, len(batch), CHUNK_SIZE):
                chunk = batch[start : start + CHUNK_SIZE]

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
                    },
                )
                product_ids = {sku: pid for sku, pid in cur.fetchall()}
                result.products_written += len(product_ids)

                # A product whose upsert returned nothing has no id to hang an
                # observation on. RETURNING always yields on a conflict-update,
                # so this stays empty in practice.
                observed = [r for r in chunk if r.retailer_sku in product_ids]

                cur.execute(
                    INSERT_OBSERVATIONS,
                    {
                        "observed_on": observed_on,
                        "product_ids": [product_ids[r.retailer_sku] for r in observed],
                        "price_cents": [r.price_cents for r in observed],
                        "was_price_cents": [r.was_price_cents for r in observed],
                        "unit_price_cents": [r.unit_price_cents for r in observed],
                        "comparison_units": [r.comparison_unit for r in observed],
                        "comparison_quantities": [r.comparison_quantity for r in observed],
                        "unit_price_sources": [r.unit_price_source for r in observed],
                        "in_stocks": [r.in_stock for r in observed],
                    },
                )
                # Rows the ON CONFLICT DO NOTHING skipped already had today's
                # observation and were left exactly as written -- the intended
                # re-run behaviour.
                inserted = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
                result.observations_inserted += inserted
                result.observations_already_present += len(observed) - inserted

        conn.commit()
    except psycopg.Error as exc:
        conn.rollback()
        result.errors.append(f"store_id={store_id}: {exc}")
        log.exception("write failed for store_id=%s, rolled back", store_id)

    return result
