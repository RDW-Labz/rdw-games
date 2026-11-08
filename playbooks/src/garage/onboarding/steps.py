"""Tool factories the Rig (T12) registers with ``anorak.loop.LoopRunner``.

``onboarding/v1/skill.yaml`` names these steps' ``do`` values by dotted
path. Each factory here closes over state the Rig already holds (an
``OnboardingSession``, a ``WatchAnswers``, and the answers/decision its own
UI already collected) and returns a plain ``anorak.loop.Tool`` -- an async
callable taking an ``ActionContext`` and returning an ``ActionResult``.
Phase 0 is thin: nothing here calls a model, a browser, or an OS API; the
Rig supplies real answers, this module only shapes them into steps.
"""

from __future__ import annotations

from collections.abc import Mapping

from anorak.loop import ActionContext, ActionResult, Tool

from garage.onboarding.session import OnboardingSession
from garage.onboarding.watch import WatchAnswers, WatchDecision, apply_decision, needs_prompt


def make_show_intro_tool(session: OnboardingSession) -> Tool:
    """The self-introduction screens step: reports how many screens there are."""

    async def show_intro(context: ActionContext) -> ActionResult:
        return ActionResult(value={"screens_shown": len(session.intro_screens)})

    return show_intro


def make_collect_answers_tool(session: OnboardingSession, answers: Mapping[str, object]) -> Tool:
    """The question step: applies only the answers for currently-pending ids.

    ``answers`` maps a question or follow-up id to the value the Rig's UI
    already collected for it. Anything not currently pending (already
    answered, or not asked this run) is left untouched -- gap-only, both
    ways.
    """

    async def collect_answers(context: ActionContext) -> ActionResult:
        asked = session.pending_question_ids()
        for question_id in asked:
            if question_id in answers:
                session.answer(question_id, answers[question_id])
        return ActionResult(value={"asked_ids": asked})

    return collect_answers


def make_write_profile_tool(session: OnboardingSession) -> Tool:
    """The risky step: writes collected answers through ``ProfileStore``.

    Listed under ``risky_steps`` in ``skill.yaml`` because it is the one
    step that changes the stored profile; the loop gates it on a yes.
    """

    async def write_profile(context: ActionContext) -> ActionResult:
        session.finish()
        return ActionResult(
            value={"status": "onboarded", "missing_fields": session.pending_question_ids()}
        )

    return write_profile


def make_ask_watch_page_tool(watch: WatchAnswers, page: str, decision: WatchDecision) -> Tool:
    """The first-visit "Can I watch this page?" step for one page.

    Only records ``decision`` when ``page`` has never been answered; a
    previously saved yes/no is left exactly as it was (never asked again),
    and "not now" is never persisted either way.
    """

    async def ask_watch_page(context: ActionContext) -> ActionResult:
        if needs_prompt(watch, page):
            apply_decision(watch, page, decision)
        return ActionResult(value={"status": "onboarded", "missing_fields": []})

    return ask_watch_page


__all__ = [
    "make_ask_watch_page_tool",
    "make_collect_answers_tool",
    "make_show_intro_tool",
    "make_write_profile_tool",
]
