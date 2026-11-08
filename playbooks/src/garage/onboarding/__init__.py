"""Onboarding script v1 (TICKETS.md T13): self-intro, questions, profile write.

Plain Python API + skill steps for the Rig (T12) to call. Phase 0 is thin:
no UI, no voice, no Rig code lives here. See ``docs/onboarding.md`` for the
screens, the question-to-field map, the drawer files, and second-run rules.
"""

from __future__ import annotations

from garage.onboarding.checker import CHECKER_NAME, make_profile_complete_checker
from garage.onboarding.data import FollowUp, Question, Screen, load_intro_screens, load_questions
from garage.onboarding.session import OnboardingSession, gap_question_ids
from garage.onboarding.watch import WatchAnswers, WatchDecision, apply_decision, needs_prompt
from garage.onboarding.writer import write_answers

__all__ = [
    "CHECKER_NAME",
    "FollowUp",
    "OnboardingSession",
    "Question",
    "Screen",
    "WatchAnswers",
    "WatchDecision",
    "apply_decision",
    "gap_question_ids",
    "load_intro_screens",
    "load_questions",
    "make_profile_complete_checker",
    "needs_prompt",
    "write_answers",
]
