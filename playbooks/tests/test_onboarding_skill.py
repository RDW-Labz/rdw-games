"""T13: onboarding/v1's own test_cases pass through almanac.runner.run_skill."""

from __future__ import annotations

from pathlib import Path

from almanac.runner import run_skill

SKILL_DIR = Path(__file__).resolve().parents[1] / "onboarding" / "v1"


def test_onboarding_skill_folder_exists() -> None:
    assert (SKILL_DIR / "SKILL.md").is_file()
    assert (SKILL_DIR / "skill.yaml").is_file()


def test_onboarding_skill_all_test_cases_pass() -> None:
    report = run_skill(SKILL_DIR)
    assert report.skill_name == "onboarding-v1"
    assert report.total == 3
    assert report.all_passed, [
        (case.case_id, case.status, case.detail) for case in report.cases if not case.passed
    ]


def test_write_profile_step_is_gated_on_a_yes() -> None:
    report = run_skill(SKILL_DIR)
    for case in report.cases:
        assert "write_profile" in case.gated_steps
