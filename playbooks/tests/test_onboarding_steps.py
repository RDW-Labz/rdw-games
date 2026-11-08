"""T13: the Tool factories the Rig registers with anorak.loop.LoopRunner."""

from __future__ import annotations

import asyncio
from pathlib import Path

from anorak.loop import ActionContext
from anorak.memory import Drawer

from garage.onboarding.session import OnboardingSession
from garage.onboarding.steps import (
    make_ask_watch_page_tool,
    make_collect_answers_tool,
    make_show_intro_tool,
    make_write_profile_tool,
)
from garage.onboarding.watch import WatchAnswers, WatchDecision

CONTEXT = ActionContext(run_id="r1", step_id="s1", attempt=1, failure=None, remaining_usd=1.0)

FULL_ANSWERS = {
    "q_name": "Pat Example",
    "q_title": "CEO, Example Holdings",
    "q_reports_to": "Board",
    "q_access_level": "admin",
    "q_ventures": ["holdings"],
    "q_tools": ["outlook"],
    "q_tools_more": [],
    "q_day": ["Mornings: email triage"],
    "q_day_more": [],
    "q_people": [{"name": "Sam Example", "role": "COO", "how_often": "daily"}],
    "q_people_more": [],
    "q_pref_tone": "short and direct",
    "q_pref_ask_before": ["send email", "pay anything"],
    "q_pref_quiet_hours": "18:00-07:00",
}


def test_show_intro_tool_reports_screen_count(tmp_path: Path) -> None:
    drawer = Drawer(tmp_path / "drawer")
    session = OnboardingSession(store=drawer.profile)
    tool = make_show_intro_tool(session)
    result = asyncio.run(tool(CONTEXT))
    assert result.value == {"screens_shown": len(session.intro_screens)}


def test_collect_and_write_profile_tools_produce_a_complete_profile(tmp_path: Path) -> None:
    drawer = Drawer(tmp_path / "drawer")
    session = OnboardingSession(store=drawer.profile)
    collect = make_collect_answers_tool(session, FULL_ANSWERS)
    asked = asyncio.run(collect(CONTEXT)).value
    assert isinstance(asked, dict)
    assert set(asked["asked_ids"]) >= {"q_name", "q_title", "q_ventures"}

    write = make_write_profile_tool(session)
    result = asyncio.run(write(CONTEXT))
    assert result.value == {"status": "onboarded", "missing_fields": []}
    assert drawer.profile.load().to_dict()["name"] == "Pat Example"


def test_ask_watch_page_tool_records_once(tmp_path: Path) -> None:
    drawer = Drawer(tmp_path / "drawer")
    watch = WatchAnswers(drawer)
    tool = make_ask_watch_page_tool(watch, "quickbooks.intuit.com", WatchDecision.YES)
    asyncio.run(tool(CONTEXT))
    assert watch.get("quickbooks.intuit.com") is True

    # A page already answered is never re-recorded, even if the Rig would
    # otherwise pass a different decision this time.
    tool_again = make_ask_watch_page_tool(watch, "quickbooks.intuit.com", WatchDecision.NO)
    asyncio.run(tool_again(CONTEXT))
    assert watch.get("quickbooks.intuit.com") is True
