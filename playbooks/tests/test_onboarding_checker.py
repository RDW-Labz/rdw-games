"""Decision #64: the onboarding-v1 skill checker, ``onboarding_profile_complete``.

Plain code, never a model. It never trusts ``CheckContext.result`` -- every
assertion here is about what is actually on disk, not what a (possibly
lying) step output claims.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import yaml
from anorak.loop import CheckContext
from anorak.memory import Drawer, Profile, ProfileStore

from garage.onboarding.checker import CHECKER_NAME, make_profile_complete_checker

_SKILL_YAML = Path(__file__).resolve().parents[1] / "onboarding" / "v1" / "skill.yaml"


def _store(tmp_path: Path) -> ProfileStore:
    return Drawer(tmp_path / "drawer").profile


def _complete_profile() -> dict[str, object]:
    return {
        "name": "Pat Example",
        "title": "CEO, Example Holdings",
        "reports_to": "Board",
        "access_level": "member",
        "ventures": ["holdings", "rdw"],
        "tools": ["outlook"],
        "people": [{"name": "Sam Example", "role": "COO", "how_often": "daily"}],
        "day": ["Mornings: email triage"],
        "preferences": {"tone": "short and direct"},
    }


def _context(result: object = None) -> CheckContext:
    return CheckContext(run_id="r1", step_id=None, result=result, remaining_usd=1.0)


def test_passes_for_a_complete_valid_profile(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.save(Profile(_complete_profile()))
    checker = make_profile_complete_checker(store)

    result = asyncio.run(checker(_context()))

    assert result.passed is True
    assert result.failure == ""


def test_fails_naming_each_missing_required_field(tmp_path: Path) -> None:
    store = _store(tmp_path)
    incomplete = {
        "name": "Pat Example",
        "title": "CEO, Example Holdings",
        "reports_to": "Board",
        "access_level": "member",
        "ventures": [],
        "tools": [],
        "people": [],
        "day": [],
        "preferences": {},
    }
    store.save(Profile(incomplete))
    checker = make_profile_complete_checker(store)

    result = asyncio.run(checker(_context()))

    assert result.passed is False
    for field in ("ventures", "tools", "people", "day", "preferences"):
        assert field in result.failure
    assert "Pat Example" not in result.failure


def test_fails_on_an_unknown_venture_code_and_names_it(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = {**_complete_profile(), "ventures": ["holdings", "not-a-real-venture"]}
    store.save(Profile(profile))
    checker = make_profile_complete_checker(store)

    result = asyncio.run(checker(_context()))

    assert result.passed is False
    assert "not-a-real-venture" in result.failure
    assert "holdings" not in result.failure


def test_fails_when_profile_yaml_is_missing(tmp_path: Path) -> None:
    store = _store(tmp_path)
    checker = make_profile_complete_checker(store)

    result = asyncio.run(checker(_context()))

    assert result.passed is False
    assert result.failure != ""


def test_ignores_a_lying_context_result_and_checks_disk_only(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.save(Profile(_complete_profile()))
    checker = make_profile_complete_checker(store)

    # A step could report a false "onboarded" status; the checker must not
    # take its word for it and must still pass because the disk is complete.
    lying_pass = asyncio.run(checker(_context(result={"status": "onboarded"})))
    assert lying_pass.passed is True

    empty_store = _store(tmp_path / "empty-drawer-root")
    empty_checker = make_profile_complete_checker(empty_store)
    lying_fail = asyncio.run(empty_checker(_context(result={"status": "onboarded"})))
    assert lying_fail.passed is False


def test_checker_name_matches_skill_yaml() -> None:
    raw = yaml.safe_load(_SKILL_YAML.read_bytes())
    assert raw["checker"] == CHECKER_NAME


def test_checker_never_calls_a_model(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.save(Profile(_complete_profile()))
    checker = make_profile_complete_checker(store)

    passing = asyncio.run(checker(_context()))
    assert passing.model is None
    assert passing.cost_usd == 0.0

    empty_store = _store(tmp_path / "second-drawer")
    empty_checker = make_profile_complete_checker(empty_store)
    failing = asyncio.run(empty_checker(_context()))
    assert failing.model is None
    assert failing.cost_usd == 0.0
