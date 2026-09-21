"""targets.json is data, not code -- but a typo in it costs a night of history."""

from __future__ import annotations

import json

from ingest.run import TARGETS_PATH, load_targets

# 30-minute job timeout in .github/workflows/ingest.yml, at 1 req/sec.
TIMEOUT_SECONDS = 30 * 60
RATE_LIMIT_SECONDS = 1.0


def test_file_is_valid_json() -> None:
    json.loads(TARGETS_PATH.read_text(encoding="utf-8"))


def test_every_store_is_fully_specified() -> None:
    for store in load_targets().stores:
        assert store.banner, "banner is required"
        assert store.store_code, "store_code is required"
        assert store.store_code.strip() == store.store_code


def test_only_verified_store_codes_are_targeted() -> None:
    """Guessed codes return 200 with zero results, which looks like success."""
    verified = {
        ("nofrills", "3131"),
        ("superstore", "1516"),
        ("loblaw", "1032"),
    }
    assert {(s.banner, s.store_code) for s in load_targets().stores} <= verified


def test_terms_are_flattened_and_deduplicated() -> None:
    targets = load_targets()
    assert len(targets.search_terms) == len(set(targets.search_terms))
    assert all(term == term.strip() and term for term in targets.search_terms)


def test_canary_terms_are_present() -> None:
    assert load_targets().canary_terms


def test_breadth_is_wide_because_history_cannot_be_backfilled() -> None:
    """A term added later starts accumulating history later. Start wide."""
    assert len(load_targets().search_terms) >= 100


def test_a_full_run_fits_inside_the_job_timeout() -> None:
    targets = load_targets()
    # +1 request per store for the canary check.
    requests = len(targets.stores) * (len(targets.search_terms) + 1)
    assert requests * RATE_LIMIT_SECONDS < TIMEOUT_SECONDS * 0.5
