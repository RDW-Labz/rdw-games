"""T13: the "Can I watch this page?" first-visit prompt, asked once per page.

Yes and No are saved and never asked again; Not now is never persisted, so
the same page is asked again next visit (PLAN.md, "What it watches").
Yes/No decisions are also mirrored into profile.yaml's watch_answers field
-- the canonical saved-answer store (DECISIONS.md #23, #38) -- whenever a
profile already exists.
"""

from __future__ import annotations

from pathlib import Path

from anorak.memory import Drawer, ProfileStore

from garage.onboarding.watch import WatchAnswers, WatchDecision, apply_decision, needs_prompt
from garage.onboarding.writer import write_answers

FULL_ANSWERS = {
    "name": "Pat Example",
    "title": "CEO, Example Holdings",
    "reports_to": "Board",
    "ventures": ["holdings"],
    "tools": ["outlook"],
    "day": ["Mornings: email triage"],
    "people": [{"name": "Sam Example", "role": "COO", "how_often": "daily"}],
}


def _answers(tmp_path: Path) -> WatchAnswers:
    return WatchAnswers(Drawer(tmp_path / "drawer"))


def _answers_with_profile(tmp_path: Path) -> tuple[WatchAnswers, ProfileStore]:
    drawer = Drawer(tmp_path / "drawer")
    write_answers(drawer.profile, FULL_ANSWERS)
    return WatchAnswers(drawer), drawer.profile


def test_a_new_page_needs_a_prompt(tmp_path: Path) -> None:
    answers = _answers(tmp_path)
    assert needs_prompt(answers, "quickbooks.intuit.com")


def test_yes_is_saved_and_never_asked_again(tmp_path: Path) -> None:
    answers = _answers(tmp_path)
    apply_decision(answers, "quickbooks.intuit.com", WatchDecision.YES)
    assert not needs_prompt(answers, "quickbooks.intuit.com")
    assert answers.get("quickbooks.intuit.com") is True

    # A second, independent WatchAnswers over the same drawer sees it too.
    reloaded = WatchAnswers(Drawer(tmp_path / "drawer"))
    assert not needs_prompt(reloaded, "quickbooks.intuit.com")


def test_no_is_saved_and_never_asked_again(tmp_path: Path) -> None:
    answers = _answers(tmp_path)
    apply_decision(answers, "facebook.com", WatchDecision.NO)
    assert not needs_prompt(answers, "facebook.com")
    assert answers.get("facebook.com") is False


def test_not_now_is_never_persisted(tmp_path: Path) -> None:
    answers = _answers(tmp_path)
    apply_decision(answers, "example.com", WatchDecision.NOT_NOW)
    assert needs_prompt(answers, "example.com")
    assert answers.get("example.com") is None


def test_each_page_is_tracked_independently(tmp_path: Path) -> None:
    answers = _answers(tmp_path)
    apply_decision(answers, "quickbooks.intuit.com", WatchDecision.YES)
    assert needs_prompt(answers, "facebook.com")


def test_yes_is_mirrored_into_profile_watch_answers(tmp_path: Path) -> None:
    answers, store = _answers_with_profile(tmp_path)
    apply_decision(answers, "quickbooks.intuit.com", WatchDecision.YES)

    assert store.load().to_dict()["watch_answers"] == {"quickbooks.intuit.com": True}
    # An independent ProfileStore over the same drawer sees the mirror too.
    reloaded = ProfileStore(store.path).load()
    assert reloaded.to_dict()["watch_answers"] == {"quickbooks.intuit.com": True}


def test_no_is_mirrored_into_profile_watch_answers(tmp_path: Path) -> None:
    answers, store = _answers_with_profile(tmp_path)
    apply_decision(answers, "facebook.com", WatchDecision.NO)

    assert store.load().to_dict()["watch_answers"] == {"facebook.com": False}


def test_not_now_is_never_mirrored_into_profile(tmp_path: Path) -> None:
    answers, store = _answers_with_profile(tmp_path)
    apply_decision(answers, "example.com", WatchDecision.NOT_NOW)

    profile = store.load()
    assert profile.to_dict().get("watch_answers", {}) == {}


def test_watch_decisions_before_a_profile_exists_are_still_saved(tmp_path: Path) -> None:
    """A page can be answered before onboarding has produced a profile.yaml
    (write_profile runs after ask_watch_page in a fresh Rig session isn't
    guaranteed) -- the decision must not be lost, and once a profile does
    exist later, an unrelated write must not silently drop it."""
    drawer = Drawer(tmp_path / "drawer")
    answers = WatchAnswers(drawer)
    apply_decision(answers, "quickbooks.intuit.com", WatchDecision.YES)
    assert drawer.profile.load_or_none() is None  # still no profile.yaml
    assert answers.get("quickbooks.intuit.com") is True

    write_answers(drawer.profile, FULL_ANSWERS)
    assert answers.get("quickbooks.intuit.com") is True


def test_record_writes_profile_yaml_atomically_with_no_leftover_temp_files(
    tmp_path: Path,
) -> None:
    answers, store = _answers_with_profile(tmp_path)
    apply_decision(answers, "quickbooks.intuit.com", WatchDecision.YES)

    leftovers = [p for p in store.path.parent.iterdir() if p.name.startswith(".new-")]
    assert leftovers == []
    # The mirrored write survives a fresh read from disk, not just memory.
    assert ProfileStore(store.path).load().to_dict()["watch_answers"] == {
        "quickbooks.intuit.com": True
    }
