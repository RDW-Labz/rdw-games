"""T13: the writer that turns onboarding answers into profile.yaml.

Every write goes through ``anorak.memory.ProfileStore`` (validated, never
bypassed). Any private drawer directory here is created through
``anorak.memory.Drawer`` (which calls anorak's private-directory
primitive), never treated as already-private just because pytest made it.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from anorak.memory import Drawer, MemoryStoreError, Profile, ProfileStore

from garage.onboarding.writer import merge_answers, write_answers

#: Onboarding never asks for or produces an "access_level" answer
#: (DECISIONS.md #31, #38) -- this is exactly the shape a real onboarding
#: run hands the writer.
FULL_ANSWERS = {
    "name": "Pat Example",
    "title": "CEO, Example Holdings",
    "reports_to": "Board",
    "ventures": ["holdings", "rdw"],
    "tools": ["outlook", "quickbooks"],
    "day": ["Mornings: email triage"],
    "people": [{"name": "Sam Example", "role": "COO", "how_often": "daily"}],
    "preferences.tone": "short and direct",
    "preferences.ask_before": ["send email", "pay anything"],
}


def _store(tmp_path: Path) -> ProfileStore:
    return Drawer(tmp_path / "drawer").profile


def test_full_first_run_produces_a_valid_profile_readable_by_profile_store(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    written = write_answers(store, FULL_ANSWERS)
    assert written.to_dict()["name"] == "Pat Example"
    assert written.to_dict()["preferences"]["tone"] == "short and direct"

    # A second, independent ProfileStore instance reads the same file back.
    reloaded = ProfileStore(store.path).load()
    assert reloaded == written
    assert reloaded.to_dict()["ventures"] == ["holdings", "rdw"]
    assert reloaded.to_dict()["preferences"]["ask_before"] == ["send email", "pay anything"]


def test_write_answers_raises_when_required_fields_are_still_missing(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(MemoryStoreError):
        write_answers(store, {"name": "Pat Example"})
    assert store.load_or_none() is None


def test_second_run_preserves_fields_it_does_not_own(tmp_path: Path) -> None:
    store = _store(tmp_path)
    write_answers(store, FULL_ANSWERS)

    updated = write_answers(store, {"preferences.quiet_hours": "18:00-07:00"})

    data = updated.to_dict()
    assert data["preferences"]["quiet_hours"] == "18:00-07:00"
    # Untouched fields and the earlier preference survive unchanged.
    assert data["name"] == "Pat Example"
    assert data["ventures"] == ["holdings", "rdw"]
    assert data["preferences"]["tone"] == "short and direct"


def _profile_shape() -> dict[str, object]:
    return {
        "name": "Pat Example",
        "title": "CEO, Example Holdings",
        "reports_to": "Board",
        "access_level": "admin",
        "ventures": ["holdings", "rdw"],
        "tools": ["outlook", "quickbooks"],
        "day": ["Mornings: email triage"],
        "people": [{"name": "Sam Example", "role": "COO", "how_often": "daily"}],
        "preferences": {"tone": "short and direct"},
    }


def test_merge_answers_keeps_watch_answers_it_does_not_own() -> None:
    base = Profile({**_profile_shape(), "watch_answers": {"example.com": True}})
    merged = merge_answers(base, {"preferences.tone": "more detail"})
    assert merged["watch_answers"] == {"example.com": True}
    assert merged["preferences"]["tone"] == "more detail"


def test_new_profile_defaults_access_level_to_member(tmp_path: Path) -> None:
    """DECISIONS.md #31, #38: a new profile defaults access_level to member."""
    store = _store(tmp_path)
    written = write_answers(store, FULL_ANSWERS)
    assert written.to_dict()["access_level"] == "member"


def test_write_answers_never_accepts_access_level_as_input(tmp_path: Path) -> None:
    """Even if something hands the writer an "access_level" answer, onboarding
    never asks for one, so it is not applied -- the default stands."""
    store = _store(tmp_path)
    written = write_answers(store, {**FULL_ANSWERS, "access_level": "admin"})
    assert written.to_dict()["access_level"] == "member"


def test_existing_admin_access_level_survives_every_onboarding_run(tmp_path: Path) -> None:
    """access_level is admin-set outside onboarding (provisioning); a second
    onboarding run must never clobber it, even with no access_level input."""
    store = _store(tmp_path)
    store.save(Profile(_profile_shape()))  # simulates Braden setting admin
    assert store.load().to_dict()["access_level"] == "admin"

    updated = write_answers(store, {"preferences.quiet_hours": "18:00-07:00"})
    assert updated.to_dict()["access_level"] == "admin"

    # And an explicit (ignored) access_level answer still can't overwrite it.
    updated_again = write_answers(store, {"access_level": "member"})
    assert updated_again.to_dict()["access_level"] == "admin"
