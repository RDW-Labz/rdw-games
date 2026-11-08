"""One onboarding run against one person's drawer.

Phase 0 is thin: this is a plain Python API. It never talks to a terminal,
a model, a browser, or an OS API -- the Rig's own UI shows the intro
screens and question prompts, collects the person's actual answers, and
calls ``answer()``/``finish()`` here. Answers are data: nothing here
inspects their content beyond the shape ``writer.write_answers`` (via
``ProfileStore``) already validates.

Second-run behaviour (TICKETS.md T13): ``pending_question_ids()`` only
ever returns ids for a missing or empty ``profile.yaml`` field -- an
already-answered question is never asked again.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from anorak.memory import Profile, ProfileStore

from garage.onboarding.data import Question, Screen, load_intro_screens, load_questions
from garage.onboarding.writer import write_answers


def _profile_field(profile: Profile | None, dotted: str) -> object:
    if profile is None:
        return None
    data = profile.to_dict()
    if dotted.startswith("preferences."):
        preferences = data.get("preferences")
        if not isinstance(preferences, dict):
            return None
        return preferences.get(dotted.split(".", 1)[1])
    return data.get(dotted)


def _is_gap(value: object) -> bool:
    return value is None or value == "" or value == [] or value == {}


def gap_question_ids(
    profile: Profile | None, questions: Sequence[Question] | None = None
) -> list[str]:
    """Ids (question then its follow-ups) still needed, in question-set order.

    A question is a gap when its mapped ``profile.yaml`` field is missing
    or empty. Its follow-ups are only asked alongside it -- they never fire
    on their own once the parent field has an answer.
    """
    questions = list(load_questions()) if questions is None else list(questions)
    ids: list[str] = []
    for question in questions:
        if _is_gap(_profile_field(profile, question.field)):
            ids.append(question.id)
            ids.extend(follow_up.id for follow_up in question.follow_ups)
    return ids


@dataclass
class OnboardingSession:
    """One onboarding run: self-intro screens, gap-only questions, one write.

    ``store`` is the person's ``ProfileStore`` (from their ``Drawer``).
    ``intro_screens``/``questions`` default to the shipped ``onboarding/v1``
    data but can be overridden (tests pass a small fixed question set).
    """

    store: ProfileStore
    intro_screens: tuple[Screen, ...] = field(default_factory=load_intro_screens)
    questions: tuple[Question, ...] = field(default_factory=load_questions)
    _existing: Profile | None = field(init=False, repr=False)
    _answers: dict[str, object] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        self._existing = self.store.load_or_none()

    def pending_question_ids(self) -> list[str]:
        """The exact ids still needed right now: only gaps, in order."""
        return gap_question_ids(self._existing, self.questions)

    def answer(self, question_id: str, value: object) -> None:
        """Record one answer from the Rig's UI, by its question or follow-up id.

        A follow-up's answer extends its parent question's field: two list
        answers are concatenated; anything else replaces the pending value.
        """
        field_name = self._field_for(question_id)
        current = self._answers.get(field_name)
        if isinstance(current, list) and isinstance(value, list):
            self._answers[field_name] = [*current, *value]
        else:
            self._answers[field_name] = value

    def _field_for(self, question_id: str) -> str:
        for question in self.questions:
            if question.id == question_id:
                return question.field
            for follow_up in question.follow_ups:
                if follow_up.id == question_id:
                    return question.field
        raise KeyError(f"Unknown onboarding question id: {question_id!r}")

    def finish(self) -> Profile:
        """Write every collected answer through ``ProfileStore``; never bypass it."""
        profile = write_answers(self.store, self._answers)
        self._existing = profile
        self._answers = {}
        return profile


__all__ = ["OnboardingSession", "gap_question_ids"]
