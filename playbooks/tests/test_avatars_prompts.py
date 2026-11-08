import re

import pytest

from garage.avatars.prompts import BANNED_NAMES, FIXED_SETTINGS, candidate_prompts


def test_six_distinct_original_directions() -> None:
    prompts = candidate_prompts(
        {"theme": "brass seedling", "mood": ["calm", "curious"], "palette_hint": "amber and moss"}
    )
    assert len(prompts) == len(set(prompts)) == 6
    for prompt in prompts:
        assert FIXED_SETTINGS in prompt
        assert "amber and moss" in prompt
        assert "calm, curious" in prompt
        assert all(name.casefold() not in prompt.casefold() for name in BANNED_NAMES)


@pytest.mark.parametrize("name", BANNED_NAMES)
@pytest.mark.parametrize("field", ["theme", "mood", "palette_hint"])
def test_names_refused_in_every_brief_field(name: str, field: str) -> None:
    brief = {"theme": "lantern", "mood": "calm", field: name.lower()}
    with pytest.raises(
        ValueError,
        match="^" + re.escape(f"brief names a real character or franchise: {name}") + "$",
    ):
        candidate_prompts(brief)


@pytest.mark.parametrize(
    "alias,name", [("R2 D2", "R2-D2"), ("ＷＡＬＬ－Ｅ", "Wall-E"), ("star—wars", "Star Wars")]
)
def test_name_punctuation_and_unicode(alias: str, name: str) -> None:
    with pytest.raises(
        ValueError, match=re.escape(f"brief names a real character or franchise: {name}")
    ):
        candidate_prompts({"theme": alias, "mood": "calm"})


@pytest.mark.parametrize(
    "brief,message",
    [
        ({}, "brief requires a non-empty theme"),
        ({"theme": "fern"}, "brief requires mood words"),
        ({"theme": "fern", "mood": [], "palette_hint": "green"}, "brief requires mood words"),
        ({"theme": "fern", "mood": "calm", "palette_hint": 3}, "palette_hint must be text"),
    ],
)
def test_invalid_brief(brief: dict[str, object], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        candidate_prompts(brief)


def test_whole_words_only_so_ordinary_words_pass() -> None:
    prompts = candidate_prompts(
        {"theme": "desert planet", "mood": ["sand dunes", "scenario", "starry", "warsaw"]}
    )
    assert len(prompts) == 6
