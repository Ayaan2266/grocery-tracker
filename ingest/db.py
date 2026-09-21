"""Postgres writes. Append-only for observations.

`price_observations` is never updated and never deleted from. Every nightly run
appends. That table is the only thing in this project a competitor cannot
retroactively reproduce, so treat it as immutable.

Upserts are confined to `products`, which is slowly-changing reference data
(name and brand can be corrected upstream), keyed on (store_id, retailer_sku).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

import psycopg

from ingest.normalize import NormalizedPrice

UPSERT_PRODUCT = """
INSERT INTO products (store_id, retailer_sku, raw_name, brand, package_size)
VALUES (%(store_id)s, %(retailer_sku)s, %(raw_name)s, %(brand)s, %(package_size)s)
ON CONFLICT (store_id, retailer_sku) DO UPDATE
    SET raw_name = EXCLUDED.raw_name,
        brand = EXCLUDED.brand,
        package_size = EXCLUDED.package_size
RETURNING id;
"""

# The unique index on (product_id, observed_on) makes a re-run idempotent:
# running ingestion twice in one day updates that day's row instead of writing
# a duplicate, so a retry after a partial failure is safe.
INSERT_OBSERVATION = """
INSERT INTO price_observations (
    product_id, price_cents, was_price_cents, unit_price_cents,
    comparison_unit, comparison_quantity, unit_price_source, in_stock,
    observed_at, observed_on
)
VALUES (
    %(product_id)s, %(price_cents)s, %(was_price_cents)s, %(unit_price_cents)s,
    %(comparison_unit)s, %(comparison_quantity)s, %(unit_price_source)s, %(in_stock)s,
    %(observed_at)s, %(observed_on)s
)
ON CONFLICT (product_id, observed_on) DO UPDATE
    SET price_cents = EXCLUDED.price_cents,
        was_price_cents = EXCLUDED.was_price_cents,
        unit_price_cents = EXCLUDED.unit_price_cents,
        in_stock = EXCLUDED.in_stock,
        observed_at = EXCLUDED.observed_at;
"""


def write_observations(
    conn: psycopg.Connection, store_id: int, rows: Sequence[NormalizedPrice]
) -> int:
    """Write one store's observations in a single transaction. Returns the
    number of observations written."""
    now = datetime.now(UTC)
    written = 0
    with conn.transaction(), conn.cursor() as cur:
        for row in rows:
            cur.execute(
                UPSERT_PRODUCT,
                {
                    "store_id": store_id,
                    "retailer_sku": row.retailer_sku,
                    "raw_name": row.raw_name,
                    "brand": row.brand,
                    "package_size": row.package_size,
                },
            )
            result = cur.fetchone()
            if result is None:
                continue
            product_id = result[0]
            cur.execute(
                INSERT_OBSERVATION,
                {
                    "product_id": product_id,
                    "price_cents": row.price_cents,
                    "was_price_cents": row.was_price_cents,
                    "unit_price_cents": row.unit_price_cents,
                    "comparison_unit": row.comparison_unit,
                    "comparison_quantity": row.comparison_quantity,
                    "unit_price_source": row.unit_price_source,
                    "in_stock": row.in_stock,
                    "observed_at": now,
                    "observed_on": now.date(),
                },
            )
            written += 1
    return written
