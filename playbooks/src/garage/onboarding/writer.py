"""Turns onboarding answers into ``profile.yaml`` through ``ProfileStore``.

Never bypasses validation: every write goes through
``anorak.memory.profile.ProfileStore.save``, which only accepts a validated
``anorak.memory.Profile``. Fields the current answers do not touch are
carried over unchanged from whatever profile already exists, so a second
onboarding run (or a page-watch answer written elsewhere) is never clobbered.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from anorak.memory import Profile, ProfileStore

#: Every field profile.yaml requires (repos/skills/docs/formats.md).
REQUIRED_FIELDS = (
    "name",
    "title",
    "reports_to",
    "access_level",
    "ventures",
    "tools",
    "people",
    "day",
    "preferences",
)

#: Structural fields it is safe to start empty; identity fields (name,
#: title, reports_to) have no sensible default and are left missing until
#: the person actually answers them. access_level is a data-role decision,
#: not an identity fact the person supplies: a new profile defaults it to
#: "member", and it is never taken from onboarding input (DECISIONS.md
#: #31, #38) -- see merge_answers, which drops any "access_level" key an
#: answers mapping might (incorrectly) contain, so an existing "admin"
#: value set during provisioning always survives every onboarding run.
_STRUCTURAL_DEFAULTS: dict[str, Any] = {
    "access_level": "member",
    "ventures": [],
    "tools": [],
    "people": [],
    "day": [],
    "preferences": {},
}


def merge_answers(existing: Profile | None, answers: Mapping[str, object]) -> dict[str, Any]:
    """Merge ``answers`` onto ``existing``, preserving fields not present in ``answers``.

    A key of the form ``"preferences.<name>"`` in ``answers`` sets one entry
    inside the ``preferences`` mapping; any other key replaces a top-level
    field outright. Everything else already in ``existing`` (including a
    ``watch_answers`` block this writer never owns) is carried over as-is.

    ``"access_level"`` is never accepted from ``answers``, even if present --
    onboarding never asks for it, so anything under that key is data this
    writer ignores, not a role decision to apply (DECISIONS.md #31, #38).
    A profile with no existing value defaults to ``"member"``; one that
    already has ``"admin"`` (set outside onboarding, during provisioning)
    keeps it, unchanged, on every run.
    """
    base: dict[str, Any] = dict(existing.to_dict()) if existing is not None else {}
    merged: dict[str, Any] = dict(base)
    for field_name, default in _STRUCTURAL_DEFAULTS.items():
        merged.setdefault(field_name, default)
    preferences: dict[str, Any] = dict(merged.get("preferences") or {})
    for key, value in answers.items():
        if key == "access_level":
            continue
        if key.startswith("preferences."):
            preferences[key.split(".", 1)[1]] = value
        else:
            merged[key] = value
    merged["preferences"] = preferences
    return merged


def write_answers(store: ProfileStore, answers: Mapping[str, object]) -> Profile:
    """Validate and durably save ``answers`` merged onto the stored profile.

    Raises ``anorak.memory.MemoryStoreError`` if a required field (such as
    ``name`` on a first run with no answer for it yet) is still missing --
    onboarding is not finished, and nothing partial is ever written in its
    place.
    """
    existing = store.load_or_none()
    merged = merge_answers(existing, answers)
    profile = Profile(merged)
    store.save(profile)
    return profile


__all__ = ["REQUIRED_FIELDS", "merge_answers", "write_answers"]
