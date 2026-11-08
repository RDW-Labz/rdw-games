"""Every theme shipped under `themes/` passes the T23 validator.

Round-one ids match their avatar set ids exactly (`docs/t23/contract.md` §1).
Lantern's light `lamp` is `200 120 0` (owner decision) and now passes every
check too; its own dedicated pass/contrast tests live in
`tests/test_themes_validate.py`.
"""

from pathlib import Path

import pytest
import yaml

from garage.themes.validate import validate_theme

THEMES = Path(__file__).resolve().parents[1] / "themes"
ROUND_ONE = ("arcade", "desert", "hitchhiker", "office", "robot", "space", "fantasy", "pets")
SHIPPED = sorted(path.name for path in THEMES.iterdir() if path.is_dir())


def test_shipped_ids_are_round_one_plus_lantern() -> None:
    assert set(SHIPPED) == {*ROUND_ONE, "lantern"}


@pytest.mark.parametrize("theme_id", SHIPPED)
def test_shipped_theme_passes_validator(theme_id: str) -> None:
    assert validate_theme(THEMES / theme_id) == []


@pytest.mark.parametrize("theme_id", SHIPPED)
def test_shipped_theme_has_light_and_dark(theme_id: str) -> None:
    data = yaml.safe_load((THEMES / theme_id / "theme.yaml").read_text())
    assert isinstance(data, dict)
    for variant in ("light", "dark"):
        assert isinstance(data.get(variant), dict)
        assert isinstance(data[variant].get("colors"), dict)


@pytest.mark.parametrize("theme_id", ROUND_ONE)
def test_round_one_theme_pairs_with_its_avatar_set(theme_id: str) -> None:
    data = yaml.safe_load((THEMES / theme_id / "theme.yaml").read_text())
    assert data["avatar"] == theme_id
    assert data["sounds"] == {"needs_you": "default", "done": "default", "problem": "default"}
