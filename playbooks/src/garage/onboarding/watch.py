"""The "Can I watch this page?" first-visit prompt and its saved-answers store.

PLAN.md ("What it watches: everything, with permission asked once"): the
first time the person lands on a new site or app, the orb asks once. Yes
("this site from now on") and No ("never this site") are saved and never
asked again; Not now is never saved, so the same page is asked again next
visit.

``profile.yaml``'s optional ``watch_answers`` field (``repos/skills/docs/
formats.md``) is the canonical, human-visible saved-answer store
(DECISIONS.md #23, #38): every Yes/No decision is mirrored there through
``anorak.memory.ProfileStore`` -- validated, atomic, never bypassed --
whenever a profile already exists. A page decision can also happen before
onboarding has produced a complete, valid ``profile.yaml`` (``Profile``
requires ``name``/``title``/``reports_to``, which onboarding may not have
collected yet), so this module keeps its own small ``watch_answers.yaml``
file in the drawer as the durable, always-available record; once a
profile exists, the two stay in sync and a read merges both, so nothing
already answered is ever asked again.

Page identity and the person's answer are both data: this module never
reads or interprets page content, and never asks the model anything.
"""

from __future__ import annotations

import os
from enum import StrEnum
from pathlib import Path
from uuid import uuid4

import yaml
from anorak.memory import Drawer, Profile, ProfileStore

#: File name inside the drawer; a sibling of profile.yaml, log.jsonl, notes/.
WATCH_ANSWERS_FILE = "watch_answers.yaml"

_MAX_BYTES = 65_536


class WatchAnswersError(ValueError):
    """``watch_answers.yaml`` exists but is not a valid saved-answers file."""


class WatchDecision(StrEnum):
    """The three answers to "Can I watch this page?"."""

    YES = "yes"
    NO = "no"
    NOT_NOW = "not_now"


class WatchAnswers:
    """Saved yes/no answers, keyed by page identity, canonical in profile.yaml.

    Reads merge ``profile.yaml``'s ``watch_answers`` field (canonical, once
    a profile exists) with the drawer's own ``<drawer>/watch_answers.yaml``
    (the durable pre-profile store; also whatever a save through
    :meth:`record` has not yet had a chance to mirror). Reads always re-read
    both current files -- no cache to go stale. Every write replaces its
    whole small mapping atomically (a temp file, then a rename over the
    original -- ``profile.yaml`` gets this for free from ``ProfileStore``,
    ``watch_answers.yaml`` does its own), so a crash mid-write never
    corrupts a previously saved answer.
    """

    def __init__(self, drawer: Drawer) -> None:
        self._path = drawer.path / WATCH_ANSWERS_FILE
        self._profile_store: ProfileStore = drawer.profile

    @property
    def path(self) -> Path:
        return self._path

    def _load_local(self) -> dict[str, bool]:
        if not self._path.exists():
            return {}
        payload = self._path.read_bytes()
        if len(payload) > _MAX_BYTES:
            raise WatchAnswersError(f"{self._path} exceeds the watch-answers size limit")
        data = yaml.safe_load(payload) or {}
        if not isinstance(data, dict) or any(
            not isinstance(page, str) or type(allowed) is not bool for page, allowed in data.items()
        ):
            raise WatchAnswersError(f"{self._path} is not a valid saved-answers mapping")
        return dict(data)

    def _load_profile_mirror(self) -> dict[str, bool]:
        profile = self._profile_store.load_or_none()
        if profile is None:
            return {}
        answers = profile.to_dict().get("watch_answers")
        if not isinstance(answers, dict):
            return {}
        return {page: allowed for page, allowed in answers.items() if isinstance(allowed, bool)}

    def _load(self) -> dict[str, bool]:
        # profile.yaml is canonical once it exists; the local file adds
        # whatever a pre-profile (or not-yet-mirrored) decision recorded.
        merged = self._load_profile_mirror()
        merged.update(self._load_local())
        return merged

    def already_asked(self, page: str) -> bool:
        """True once ``page`` has a saved yes/no; Not now never counts."""
        return page in self._load()

    def get(self, page: str) -> bool | None:
        """The saved answer for ``page``, or ``None`` if never saved."""
        return self._load().get(page)

    def record(self, page: str, allowed: bool) -> None:
        """Save yes (``True``) or no (``False``) for ``page``. Never call this for Not now.

        Always durably saved to this drawer's own ``watch_answers.yaml``
        first (so this never depends on a profile already existing), then
        mirrored into ``profile.yaml``'s ``watch_answers`` field -- through
        the validated, atomic ``ProfileStore`` -- whenever a profile is
        already there to receive it.
        """
        data = self._load_local()
        data[page] = allowed
        payload = yaml.safe_dump(data, sort_keys=True, allow_unicode=True).encode()
        temporary = self._path.with_name(f".new-{uuid4().hex}")
        with open(temporary, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self._path)
        self._mirror_to_profile(page, allowed)

    def _mirror_to_profile(self, page: str, allowed: bool) -> None:
        profile = self._profile_store.load_or_none()
        if profile is None:
            return
        merged = profile.to_dict()
        raw_answers = merged.get("watch_answers")
        answers = dict(raw_answers) if isinstance(raw_answers, dict) else {}
        answers[page] = allowed
        merged["watch_answers"] = answers
        self._profile_store.save(Profile(merged))


def needs_prompt(answers: WatchAnswers, page: str) -> bool:
    """True when ``page`` has never been answered yes/no -- ask it now."""
    return not answers.already_asked(page)


def apply_decision(answers: WatchAnswers, page: str, decision: WatchDecision) -> None:
    """Record a decision. Not now is intentionally never persisted."""
    if decision is WatchDecision.YES:
        answers.record(page, True)
    elif decision is WatchDecision.NO:
        answers.record(page, False)


__all__ = [
    "WATCH_ANSWERS_FILE",
    "WatchAnswers",
    "WatchAnswersError",
    "WatchDecision",
    "apply_decision",
    "needs_prompt",
]
