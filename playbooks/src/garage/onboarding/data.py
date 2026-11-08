"""Loads onboarding v1's data-driven content: intro screens and questions.

Both files live beside this package's ``skill.yaml``, at ``onboarding/v1/``
in the repo root, and are read with YAML's safe loader. Their text is data:
it is never interpolated into a plan, a prompt, or a shell command. The
wheel force-includes the same three files under ``garage/onboarding/v1/``
(see ``pyproject.toml``) so an installed, vendored copy of this package can
load its own data without a repo checkout nearby.
"""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import field as dc_field
from pathlib import Path
from typing import Any

import yaml

#: src/garage/onboarding/data.py -> onboarding -> garage -> src -> repo root
_REPO_ONBOARDING_DIR = Path(__file__).resolve().parents[3] / "onboarding" / "v1"
#: src/garage/onboarding/data.py -> onboarding -> v1 (force-included in the wheel)
_PACKAGE_ONBOARDING_DIR = Path(__file__).resolve().parent / "v1"


def _onboarding_dir(package_dir: Path, repo_dir: Path) -> Path:
    """Prefer the packaged copy of the onboarding data, falling back to the repo."""
    if (package_dir / "intro.yaml").is_file():
        return package_dir
    return repo_dir


ONBOARDING_DIR = _onboarding_dir(_PACKAGE_ONBOARDING_DIR, _REPO_ONBOARDING_DIR)

_MAX_YAML_BYTES = 200_000


class OnboardingDataError(ValueError):
    """``intro.yaml`` or ``questions.yaml`` is missing or malformed."""


def _load_mapping(path: Path) -> dict[str, Any]:
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise OnboardingDataError(f"Cannot read {path}: {exc}") from exc
    if len(payload) > _MAX_YAML_BYTES:
        raise OnboardingDataError(f"{path} exceeds the onboarding data size limit")
    try:
        data = yaml.safe_load(payload)
    except yaml.YAMLError as exc:
        raise OnboardingDataError(f"Invalid YAML in {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise OnboardingDataError(f"{path} must contain a YAML mapping")
    return data


@dataclass(frozen=True)
class Screen:
    """One short self-introduction screen."""

    id: str
    text: str


@dataclass(frozen=True)
class FollowUp:
    """A question asked right after its parent; extends the same field."""

    id: str
    prompt: str


@dataclass(frozen=True)
class Question:
    """One onboarding question, mapped to exactly one ``profile.yaml`` field."""

    id: str
    field: str
    kind: str
    prompt: str
    follow_ups: tuple[FollowUp, ...] = dc_field(default_factory=tuple)


def load_intro_screens(base: Path = ONBOARDING_DIR) -> tuple[Screen, ...]:
    """Load the self-introduction screens in on-screen order."""
    raw = _load_mapping(base / "intro.yaml")
    screens = raw.get("screens")
    if not isinstance(screens, list) or not screens:
        raise OnboardingDataError("intro.yaml must have a non-empty 'screens' list")
    result: list[Screen] = []
    for item in screens:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("id"), str)
            or not item["id"]
            or not isinstance(item.get("text"), str)
            or not item["text"].strip()
        ):
            raise OnboardingDataError("Each intro screen needs a non-empty 'id' and 'text'")
        result.append(Screen(id=item["id"], text=item["text"]))
    return tuple(result)


def _load_follow_ups(raw: object, question_id: str) -> tuple[FollowUp, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise OnboardingDataError(f"Question '{question_id}' has an invalid 'follow_ups'")
    result: list[FollowUp] = []
    for item in raw:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("id"), str)
            or not item["id"]
            or not isinstance(item.get("prompt"), str)
            or not item["prompt"].strip()
        ):
            raise OnboardingDataError(
                f"Question '{question_id}' has a follow-up missing 'id' or 'prompt'"
            )
        result.append(FollowUp(id=item["id"], prompt=item["prompt"]))
    return tuple(result)


def load_questions(base: Path = ONBOARDING_DIR) -> tuple[Question, ...]:
    """Load the question set in ask order."""
    raw = _load_mapping(base / "questions.yaml")
    items = raw.get("questions")
    if not isinstance(items, list) or not items:
        raise OnboardingDataError("questions.yaml must have a non-empty 'questions' list")
    seen_ids: set[str] = set()
    result: list[Question] = []
    for item in items:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("id"), str)
            or not item["id"]
            or not isinstance(item.get("field"), str)
            or not item["field"]
            or not isinstance(item.get("kind"), str)
            or not item["kind"]
            or not isinstance(item.get("prompt"), str)
            or not item["prompt"].strip()
        ):
            raise OnboardingDataError("Each question needs 'id', 'field', 'kind' and 'prompt'")
        if item["field"] == "access_level":
            # DECISIONS.md #31, #38: access_level is admin-set, never an
            # onboarding question. Refuse the file outright rather than ask it.
            raise OnboardingDataError(
                "questions.yaml must never ask for 'access_level'; it is admin-set"
            )
        follow_ups = _load_follow_ups(item.get("follow_ups"), item["id"])
        for question_id in (item["id"], *(f.id for f in follow_ups)):
            if question_id in seen_ids:
                raise OnboardingDataError(f"Duplicate question id: {question_id}")
            seen_ids.add(question_id)
        result.append(
            Question(
                id=item["id"],
                field=item["field"],
                kind=item["kind"],
                prompt=item["prompt"],
                follow_ups=follow_ups,
            )
        )
    return tuple(result)


__all__ = [
    "ONBOARDING_DIR",
    "FollowUp",
    "OnboardingDataError",
    "Question",
    "Screen",
    "load_intro_screens",
    "load_questions",
]
