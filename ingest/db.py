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

UPSERT_PRODUCT = """
INSERT INTO products (
    store_id, retailer_sku, raw_name, brand, package_size, size_value, size_unit
) VALUES (%s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (store_id, retailer_sku) DO UPDATE
   SET raw_name     = EXCLUDED.raw_name,
       brand        = EXCLUDED.brand,
       package_size = EXCLUDED.package_size,
       size_value   = EXCLUDED.size_value,
       size_unit    = EXCLUDED.size_unit
RETURNING id
"""

INSERT_OBSERVATION = """
INSERT INTO price_observations (
    product_id, price_cents, was_price_cents, unit_price_cents,
    comparison_unit, comparison_quantity, unit_price_source, in_stock, observed_on
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
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
    """
    result = WriteResult()
    try:
        with conn.cursor() as cur:
            for row in rows:
                cur.execute(
                    UPSERT_PRODUCT,
                    (
                        store_id,
                        row.retailer_sku,
                        row.raw_name,
                        row.brand,
                        row.package_size,
                        row.size_value,
                        row.size_unit,
                    ),
                )
                product_row = cur.fetchone()
                if product_row is None:  # pragma: no cover - RETURNING always yields
                    continue
                product_id = int(product_row[0])
                result.products_written += 1

                cur.execute(
                    INSERT_OBSERVATION,
                    (
                        product_id,
                        row.price_cents,
                        row.was_price_cents,
                        row.unit_price_cents,
                        row.comparison_unit,
                        row.comparison_quantity,
                        row.unit_price_source,
                        row.in_stock,
                        observed_on,
                    ),
                )
                # rowcount 0 means ON CONFLICT DO NOTHING fired: today's
                # observation for this product already exists and was left
                # untouched, which is the intended re-run behaviour.
                if cur.rowcount:
                    result.observations_inserted += 1
                else:
                    result.observations_already_present += 1
        conn.commit()
    except psycopg.Error as exc:
        conn.rollback()
        result.errors.append(f"store_id={store_id}: {exc}")
        log.exception("write failed for store_id=%s, rolled back", store_id)

    return result
