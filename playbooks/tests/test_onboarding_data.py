"""T13: the self-introduction screens and the data-driven question set."""

from __future__ import annotations

import tomllib
from pathlib import Path

from garage.onboarding.data import _onboarding_dir, load_intro_screens, load_questions

#: Words a non-technical employee's onboarding screens must never use
#: (AGENTS.md: "Nothing you build should require an employee to see a
#: terminal, an API key, or a settings screen.").
FORBIDDEN_WORDS = ("terminal", "api key", "token", "settings")


def test_intro_screens_have_no_forbidden_words() -> None:
    screens = load_intro_screens()
    assert len(screens) >= 4
    for screen in screens:
        lowered = screen.text.lower()
        for word in FORBIDDEN_WORDS:
            assert word not in lowered, f"{screen.id!r} uses forbidden word {word!r}"


def test_intro_screens_cover_the_required_topics() -> None:
    ids = {screen.id for screen in load_intro_screens()}
    assert {"what_i_am", "what_i_watch", "what_i_never_do", "how_to_pause_me"} <= ids


def test_questions_have_unique_ids_and_known_fields() -> None:
    questions = load_questions()
    seen: set[str] = set()
    for question in questions:
        assert question.id not in seen
        seen.add(question.id)
        for follow_up in question.follow_ups:
            assert follow_up.id not in seen
            seen.add(follow_up.id)
        assert question.field  # non-empty
        assert question.kind in {"text", "choice", "list", "people"}


def test_questions_cover_every_required_profile_field() -> None:
    fields = {question.field for question in load_questions()}
    required_top_level = {
        "name",
        "title",
        "reports_to",
        "ventures",
        "tools",
        "day",
        "people",
    }
    assert required_top_level <= fields
    assert any(field.startswith("preferences.") for field in fields)

    # access_level is a required profile.yaml field, but DECISIONS.md #31,
    # #38 make it admin-set, not something onboarding asks: it defaults to
    # "member" and Braden sets "admin" during provisioning, outside
    # onboarding. It is deliberately excluded from required_top_level above
    # and must never appear as a question field.
    assert "access_level" not in fields


def test_onboarding_dir_prefers_the_packaged_copy_when_present(tmp_path: Path) -> None:
    package_dir = tmp_path / "package" / "v1"
    package_dir.mkdir(parents=True)
    (package_dir / "intro.yaml").write_text("screens: []\n")
    repo_dir = tmp_path / "repo" / "onboarding" / "v1"
    repo_dir.mkdir(parents=True)

    assert _onboarding_dir(package_dir, repo_dir) == package_dir


def test_onboarding_dir_falls_back_to_the_repo_copy_when_unpackaged(tmp_path: Path) -> None:
    package_dir = tmp_path / "package" / "v1"  # never created: no wheel force-include here
    repo_dir = tmp_path / "repo" / "onboarding" / "v1"
    repo_dir.mkdir(parents=True)

    assert _onboarding_dir(package_dir, repo_dir) == repo_dir


def test_pyproject_force_includes_exactly_the_three_onboarding_files() -> None:
    pyproject_path = Path(__file__).resolve().parents[1] / "pyproject.toml"
    with pyproject_path.open("rb") as handle:
        config = tomllib.load(handle)

    force_include = config["tool"]["hatch"]["build"]["targets"]["wheel"]["force-include"]
    onboarding_entries = {k: v for k, v in force_include.items() if k.startswith("onboarding/")}
    assert onboarding_entries == {
        "onboarding/v1/intro.yaml": "garage/onboarding/v1/intro.yaml",
        "onboarding/v1/questions.yaml": "garage/onboarding/v1/questions.yaml",
        "onboarding/v1/skill.yaml": "garage/onboarding/v1/skill.yaml",
    }
