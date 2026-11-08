"""T13: full first run, then a second run that asks only the exact gaps.

Uses a small fixed question set (not the shipped onboarding/v1 set) so the
assertions are independent of any future edit to questions.yaml. The
drawer is created through ``anorak.memory.Drawer`` (its private-directory
primitive), never treated as private just because pytest made the folder.
"""

from __future__ import annotations

from pathlib import Path

from anorak.memory import Drawer, Profile

from garage.onboarding.data import FollowUp, Question, load_questions
from garage.onboarding.session import OnboardingSession, gap_question_ids

QUESTIONS = (
    Question(id="q_name", field="name", kind="text", prompt="What should I call you?"),
    Question(id="q_title", field="title", kind="text", prompt="What's your job title?"),
    Question(id="q_reports_to", field="reports_to", kind="text", prompt="Who do you report to?"),
    Question(id="q_ventures", field="ventures", kind="list", prompt="Which ventures?"),
    Question(
        id="q_tools",
        field="tools",
        kind="list",
        prompt="What tools?",
        follow_ups=(FollowUp(id="q_tools_more", prompt="Any other tools?"),),
    ),
    Question(id="q_day", field="day", kind="list", prompt="Walk me through a normal day."),
    Question(id="q_people", field="people", kind="people", prompt="Who do you work with?"),
    Question(id="q_pref_tone", field="preferences.tone", kind="text", prompt="How should I talk?"),
)

FULL_FAKE_ANSWERS: dict[str, object] = {
    "q_name": "Pat Example",
    "q_title": "CEO, Example Holdings",
    "q_reports_to": "Board",
    "q_ventures": ["holdings", "rdw"],
    "q_tools": ["outlook"],
    "q_tools_more": ["quickbooks"],
    "q_day": ["Mornings: email triage"],
    "q_people": [{"name": "Sam Example", "role": "COO", "how_often": "daily"}],
    "q_pref_tone": "short and direct",
}


def _session(tmp_path: Path, name: str = "drawer") -> OnboardingSession:
    drawer = Drawer(tmp_path / name)
    return OnboardingSession(store=drawer.profile, intro_screens=(), questions=QUESTIONS)


def test_first_run_asks_every_question_and_its_follow_ups(tmp_path: Path) -> None:
    session = _session(tmp_path)
    pending = session.pending_question_ids()
    assert pending == [
        "q_name",
        "q_title",
        "q_reports_to",
        "q_ventures",
        "q_tools",
        "q_tools_more",
        "q_day",
        "q_people",
        "q_pref_tone",
    ]


def test_full_first_run_then_second_run_asks_only_the_exact_gaps(tmp_path: Path) -> None:
    drawer = Drawer(tmp_path / "drawer")
    first = OnboardingSession(store=drawer.profile, intro_screens=(), questions=QUESTIONS)
    assert first.pending_question_ids()  # something to ask on a fresh profile
    for question_id, value in FULL_FAKE_ANSWERS.items():
        first.answer(question_id, value)
    first.finish()

    # A brand new session against the same drawer sees the saved profile.
    second = OnboardingSession(store=drawer.profile, intro_screens=(), questions=QUESTIONS)
    assert second.pending_question_ids() == []

    # Now one field goes empty again (the person cleared their tone
    # preference) -- only that gap, plus nothing else, should be asked.
    profile = drawer.profile.load()
    data = profile.to_dict()
    data["preferences"] = {}
    drawer.profile.save(Profile(data))

    third = OnboardingSession(store=drawer.profile, intro_screens=(), questions=QUESTIONS)
    assert third.pending_question_ids() == ["q_pref_tone"]


def test_gap_question_ids_with_no_profile_returns_every_id() -> None:
    ids = gap_question_ids(None, QUESTIONS)
    assert ids[0] == "q_name"
    assert "q_tools_more" in ids
    assert len(ids) == len(QUESTIONS) + 1  # one follow-up in this fixed set


def test_shipped_question_set_never_asks_for_access_level() -> None:
    """DECISIONS.md #31, #38: access_level is admin-set, never an onboarding
    question -- new profiles default it to member; onboarding never asks."""
    questions = load_questions()
    ids = {question.id for question in questions}
    fields = {question.field for question in questions}
    for question in questions:
        ids.update(follow_up.id for follow_up in question.follow_ups)
    assert "q_access_level" not in ids
    assert "access_level" not in fields
    assert "q_access_level" not in gap_question_ids(None, questions)
