"""Ingestion entry point.

    python -m ingest.run --dry-run    # fetch and normalize, write nothing
    python -m ingest.run              # write to Postgres

Exit codes:
    0  every targeted store ingested
    1  at least one store failed
    2  HTTP 403 -- stop signal, see AccessDenied in sources/loblaw.py
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from ingest.config import ConfigError, load_settings
from ingest.normalize import NormalizedPrice, normalize_entry
from ingest.sources.loblaw import (
    AccessDenied,
    IngestError,
    LoblawClient,
    StoreVerificationError,
)

log = logging.getLogger("ingest")

TARGETS_PATH = Path(__file__).parent / "targets.json"

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_ACCESS_DENIED = 2


@dataclass(frozen=True)
class StoreTarget:
    banner: str
    store_code: str
    label: str

    @property
    def key(self) -> str:
        return f"{self.banner}/{self.store_code}"


@dataclass
class Targets:
    stores: list[StoreTarget]
    canary_terms: tuple[str, ...]
    search_terms: list[str]


@dataclass
class StoreOutcome:
    target: StoreTarget
    fetched: int = 0
    normalized: int = 0
    skipped_no_price: int = 0
    on_sale: int = 0
    inserted: int = 0
    already_present: int = 0
    error: str | None = None
    rows: list[NormalizedPrice] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.error is None


def load_targets(path: Path = TARGETS_PATH) -> Targets:
    """Load the store and term list. Terms are flattened and de-duplicated."""
    raw = json.loads(path.read_text(encoding="utf-8"))

    stores = [
        StoreTarget(
            banner=entry["banner"],
            store_code=str(entry["store_code"]),
            label=entry.get("label", ""),
        )
        for entry in raw["stores"]
    ]

    seen: dict[str, None] = {}
    for group in raw["search_terms"].values():
        for term in group:
            cleaned = term.strip()
            if cleaned:
                seen.setdefault(cleaned, None)

    return Targets(
        stores=stores,
        canary_terms=tuple(raw.get("canary_terms", ())),
        search_terms=list(seen),
    )


def ingest_store(
    client: LoblawClient,
    target: StoreTarget,
    terms: list[str],
    canary_terms: tuple[str, ...],
    observed_on: date,
) -> StoreOutcome:
    """Fetch and normalize one store. Does not write."""
    outcome = StoreOutcome(target=target)

    # Canary first. A bad storeId returns 200 with zero results, so without
    # this an empty night is indistinguishable from a working store that had
    # nothing in stock.
    try:
        client.verify_store(
            target.banner, target.store_code, terms=canary_terms, on_date=observed_on
        )
    except StoreVerificationError as exc:
        outcome.error = str(exc)
        log.error("%s canary failed: %s", target.key, exc)
        return outcome

    by_sku: dict[str, NormalizedPrice] = {}
    for term in terms:
        try:
            response = client.search(target.banner, target.store_code, term, on_date=observed_on)
        except AccessDenied:
            # AccessDenied subclasses IngestError, so without this it would be
            # recorded as a per-store failure and the loop would move on to the
            # next store -- still hitting an API that has just told us to stop,
            # and exiting 1 instead of 2. Let it reach main().
            raise
        except IngestError as exc:
            outcome.error = str(exc)
            log.error("%s term %r failed: %s", target.key, term, exc)
            return outcome

        outcome.fetched += len(response.results)
        for entry in response.results:
            row = normalize_entry(entry)
            if row is None:
                outcome.skipped_no_price += 1
                continue
            # The same SKU surfaces under several search terms. One observation
            # per product per day is what the schema's unique constraint wants,
            # so collapse here rather than relying on ON CONFLICT to absorb it.
            by_sku[row.retailer_sku] = row

    outcome.rows = list(by_sku.values())
    outcome.normalized = len(outcome.rows)
    outcome.on_sale = sum(1 for row in outcome.rows if row.on_sale)

    if outcome.skipped_no_price > outcome.normalized:
        log.warning(
            "%s: %d entries had no usable price vs %d that did -- check whether the "
            "`prices` field was renamed upstream",
            target.key,
            outcome.skipped_no_price,
            outcome.normalized,
        )

    return outcome


def print_summary(outcomes: list[StoreOutcome], *, dry_run: bool) -> None:
    mode = "DRY RUN (nothing written)" if dry_run else "WROTE TO POSTGRES"
    print(f"\n{'=' * 72}\n{mode}\n{'=' * 72}")
    header = f"{'store':<34}{'fetched':>8}{'kept':>7}{'sale':>6}{'new':>6}{'dup':>6}"
    print(header)
    print("-" * 72)
    for outcome in outcomes:
        label = outcome.target.label or outcome.target.key
        if not outcome.ok:
            print(f"{label:<34}{'FAILED':>33}")
            continue
        print(
            f"{label:<34}{outcome.fetched:>8}{outcome.normalized:>7}"
            f"{outcome.on_sale:>6}{outcome.inserted:>6}{outcome.already_present:>6}"
        )
    print("-" * 72)
    print(
        f"{'total':<34}{sum(o.fetched for o in outcomes):>8}"
        f"{sum(o.normalized for o in outcomes):>7}"
        f"{sum(o.on_sale for o in outcomes):>6}"
        f"{sum(o.inserted for o in outcomes):>6}"
        f"{sum(o.already_present for o in outcomes):>6}"
    )
    for outcome in outcomes:
        if not outcome.ok:
            print(f"\n  {outcome.target.key}: {outcome.error}")


def redact_password(message: str, database_url: str) -> str:
    """Replace the connection-string password wherever it appears in a message.

    Belt and braces alongside withholding parse errors entirely. Driver errors
    quote all sorts of context, and anything this function returns is headed
    for a CI log that anyone can read.
    """
    match = re.search(r"://[^:/@\s]+:([^@\s]+)@", database_url)
    if match and match.group(1):
        return message.replace(match.group(1), "***")
    return message


def preflight(database_url: str, stores: list[StoreTarget]) -> str | None:
    """Prove the database is writable before spending any API requests on it.

    Returns None when everything resolves, or a message describing what is
    wrong. Costs about a second.

    Without this, a bad DATABASE_URL or a missing migration is only discovered
    after the whole night has been fetched -- 500-odd requests against an
    undocumented API we have no permission to use, thrown away because of a
    typo in a secret. Resolving every target store also catches the case where
    targets.json names a store that no migration has added yet.
    """
    from ingest import db

    try:
        with db.connect(database_url) as conn:
            for target in stores:
                db.resolve_store_id(conn, target.banner, target.store_code)
    except db.UnknownStore as exc:
        return str(exc)
    except db.psycopg.ProgrammingError:
        # psycopg quotes the offending part of the connection string, which is
        # almost always the password. Never echo it: Actions logs on a public
        # repo are public, and GitHub only masks exact matches of the whole
        # secret, not fragments of it.
        return (
            "DATABASE_URL is malformed -- most likely an unencoded character in the "
            "password. Percent-encode % as %25, # as %23, @ as %40, : as %3A, / as %2F. "
            "The underlying error is withheld because it quotes the connection string."
        )
    except db.psycopg.Error as exc:
        return f"cannot connect to Postgres: {redact_password(str(exc), database_url)}"
    return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m ingest.run", description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and normalize without writing to Postgres. No DATABASE_URL needed.",
    )
    parser.add_argument(
        "--store",
        action="append",
        metavar="BANNER/CODE",
        help="Limit to one store, e.g. --store nofrills/3131. Repeatable.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        metavar="N",
        help="Use only the first N search terms. For smoke tests, not for nightly runs.",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Debug logging.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    # httpx logs a line per request at INFO. A full night is 500+ requests,
    # which buries the canary results and the summary in the Actions log.
    if not args.verbose:
        logging.getLogger("httpx").setLevel(logging.WARNING)

    try:
        settings = load_settings(require_database=not args.dry_run)
    except ConfigError as exc:
        log.error("%s", exc)
        return EXIT_FAILURE

    targets = load_targets()
    stores = targets.stores
    if args.store:
        wanted = set(args.store)
        stores = [s for s in stores if s.key in wanted]
        if not stores:
            log.error("no store in targets.json matched %s", sorted(wanted))
            return EXIT_FAILURE

    terms = targets.search_terms[: args.limit] if args.limit else targets.search_terms
    observed_on = date.today()

    log.info(
        "ingesting %d store(s) x %d term(s) at %.1fs/request -- roughly %.1f min",
        len(stores),
        len(terms),
        settings.rate_limit_seconds,
        (len(stores) * (len(terms) + 1) * settings.rate_limit_seconds) / 60,
    )

    if not args.dry_run:
        assert settings.database_url is not None
        problem = preflight(settings.database_url, stores)
        if problem:
            log.error("preflight failed, no API requests made -- fix this first:\n  %s", problem)
            return EXIT_FAILURE
        log.info("preflight ok: database reachable, %d store(s) resolved", len(stores))

    outcomes: list[StoreOutcome] = []
    with LoblawClient(
        settings.pcx_api_key, rate_limit_seconds=settings.rate_limit_seconds
    ) as client:
        for target in stores:
            log.info("=> %s (%s)", target.key, target.label)
            try:
                outcomes.append(
                    ingest_store(client, target, terms, targets.canary_terms, observed_on)
                )
            except AccessDenied as exc:
                # Never retried, never worked around. Abandon the whole run.
                log.error("ACCESS DENIED: %s", exc)
                print_summary(outcomes, dry_run=args.dry_run)
                return EXIT_ACCESS_DENIED

    if not args.dry_run:
        _write(settings.database_url, outcomes, observed_on)

    print_summary(outcomes, dry_run=args.dry_run)
    return EXIT_OK if all(o.ok for o in outcomes) else EXIT_FAILURE


def _write(database_url: str | None, outcomes: list[StoreOutcome], observed_on: date) -> None:
    # Imported here so that --dry-run works without psycopg being able to
    # reach a database, and without importing it at all.
    from ingest import db

    assert database_url is not None
    try:
        connection = db.connect(database_url)
    except db.psycopg.Error as exc:
        # Preflight makes this unlikely, but the database can go away mid-run.
        # Record it against every store and return, so print_summary still runs
        # and the night's work is at least visible in the log.
        log.error("could not connect to Postgres, nothing written: %s", exc)
        for outcome in outcomes:
            if outcome.ok:
                outcome.error = f"database unavailable: {exc}"
        return

    with connection as conn:
        for outcome in outcomes:
            if not outcome.ok or not outcome.rows:
                continue
            try:
                store_id = db.resolve_store_id(
                    conn, outcome.target.banner, outcome.target.store_code
                )
            except db.UnknownStore as exc:
                outcome.error = str(exc)
                log.error("%s", exc)
                continue

            result = db.write_store_observations(conn, store_id, outcome.rows, observed_on)
            outcome.inserted = result.observations_inserted
            outcome.already_present = result.observations_already_present
            if result.errors:
                outcome.error = "; ".join(result.errors)


if __name__ == "__main__":
    sys.exit(main())
