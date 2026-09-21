"""Nightly ingestion entry point.

    python -m ingest.run --banner nofrills --store 3131

Targets are read from ingest/targets.json so that adding a store or a search
term is a data change, not a code change.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

import psycopg

from ingest.config import Settings
from ingest.db import write_observations
from ingest.normalize import normalize
from ingest.sources.loblaw import LoblawClient, StoreVerificationError

log = logging.getLogger("ingest")

TARGETS_PATH = Path(__file__).parent / "targets.json"


def load_targets() -> list[dict]:
    return json.loads(TARGETS_PATH.read_text())["stores"]


def ingest_store(client: LoblawClient, target: dict, conn: psycopg.Connection | None) -> int:
    banner, store_code = target["banner"], target["store_code"]
    client.verify_store(banner, store_code)

    rows = []
    for term in target["terms"]:
        for product in client.search_all(banner, store_code, term, max_products=target["cap"]):
            rows.append(normalize(product))

    # Same SKU can surface under several search terms. Last write wins; they
    # carry identical pricing within a run.
    deduped = list({row.retailer_sku: row for row in rows}.values())
    log.info("%s/%s: %d products (%d before dedup)", banner, store_code, len(deduped), len(rows))

    if conn is None:
        return len(deduped)
    return write_observations(conn, target["store_id"], deduped)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ingest Loblaw store-level pricing")
    parser.add_argument("--banner", help="Only run this banner")
    parser.add_argument(
        "--dry-run", action="store_true", help="Fetch and normalize but do not write to Postgres"
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    settings = Settings.from_env()

    targets = [t for t in load_targets() if not args.banner or t["banner"] == args.banner]
    if not targets:
        log.error("No targets matched")
        return 1

    conn = None if args.dry_run else psycopg.connect(settings.database_url)
    failures = 0
    try:
        with LoblawClient(settings) as client:
            for target in targets:
                try:
                    written = ingest_store(client, target, conn)
                    log.info("wrote %d observations for %s", written, target["store_code"])
                except StoreVerificationError:
                    # Do not swallow this. A silently-empty store is the failure
                    # mode that makes months of empty runs look successful.
                    log.exception("store verification failed")
                    failures += 1
                except Exception:
                    log.exception("ingest failed for %s", target["store_code"])
                    failures += 1
    finally:
        if conn is not None:
            conn.close()

    # Non-zero exit turns the GitHub Action red, which is the only alerting
    # this project has and all it needs.
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
