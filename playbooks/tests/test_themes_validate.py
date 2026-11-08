import copy
from pathlib import Path
from typing import Any

import pytest
import yaml

from garage.themes.contrast import contrast_ratio, contrast_ratio_hex, hex_rgb
from garage.themes.validate import TEXT_PAIRS, UI_PAIRS, validate_theme

LANTERN = Path(__file__).resolve().parents[1] / "themes/lantern"


def lantern_theme() -> dict[str, Any]:
    data = yaml.safe_load(LANTERN.joinpath("theme.yaml").read_text())
    assert isinstance(data, dict)
    return data


def write_theme(directory: Path, data: dict[str, Any]) -> Path:
    directory.joinpath("theme.yaml").write_text(yaml.safe_dump(data, sort_keys=False))
    return directory


def set_path(data: dict[str, Any], dotted: str, value: object) -> None:
    parts = dotted.split(".")
    target = data
    for part in parts[:-1]:
        target = target[part]
    target[parts[-1]] = value


def del_path(data: dict[str, Any], dotted: str) -> None:
    parts = dotted.split(".")
    target = data
    for part in parts[:-1]:
        target = target[part]
    del target[parts[-1]]


@pytest.fixture
def theme(tmp_path: Path) -> Path:
    return write_theme(tmp_path, lantern_theme())


# -- contrast.py: WCAG math against known values -----------------------------


def test_black_on_white_is_21() -> None:
    assert contrast_ratio((0, 0, 0), (255, 255, 255)) == pytest.approx(21.0, abs=1e-6)


def test_777_on_white_is_about_4_48() -> None:
    assert contrast_ratio_hex("#777777", "#ffffff") == pytest.approx(4.48, abs=0.01)


def test_contrast_is_symmetric() -> None:
    assert contrast_ratio_hex("#123456", "#fedcba") == pytest.approx(
        contrast_ratio_hex("#fedcba", "#123456"), abs=1e-9
    )


def test_same_colour_is_ratio_1() -> None:
    assert contrast_ratio_hex("#336699", "#336699") == pytest.approx(1.0, abs=1e-9)


def test_hex_rgb_rejects_bad_input() -> None:
    assert hex_rgb("#fff") is None
    assert hex_rgb("#1f1d1a52") is None  # 8-hex (alpha) is not a contrast colour
    assert hex_rgb(42) is None
    assert hex_rgb("#1f1d1a") == (0x1F, 0x1D, 0x1A)


def test_contrast_ratio_hex_none_on_bad_colour() -> None:
    assert contrast_ratio_hex("not-a-colour", "#ffffff") is None


# -- lantern ships valid ------------------------------------------------------


def test_lantern_structural_and_dark_contrast_all_pass() -> None:
    """Every §1 structural rule and every §2 contrast pair passes for the
    shipped Lantern data: this pins that the checker is not over-firing
    anywhere. Lantern's light `lamp` used to be the one known gap here
    (owner decision: light lamp -> `200 120 0`, ~3.14:1 on `light.bg`,
    clears the 3:1 UI floor) -- see the dedicated test below."""
    errors = validate_theme(LANTERN)
    assert errors == []


def test_lantern_light_lamp_bg_contrast_now_passes() -> None:
    """`contrast.py` is verified against the known WCAG reference values
    above (#000/#fff = 21.0, #777/#fff ~= 4.48, red/white ~= 4.0), and every
    *other* contract §2 pair -- including `rim`/`bg` in the same light
    variant -- clears its floor comfortably. Lantern's old light-mode `lamp`
    ("240 181 69") against `light.bg` ("#f7f5f0") was ~1.69:1, short of
    decision #167's 3:1 floor, because a warm gold read poorly against a
    near-white "Daylight" field. Per the owner decision, the light lamp is
    now `200 120 0` (~3.14:1 on the same background) -- the dark lamp is
    unchanged. `themes/lantern/theme.yaml` no longer needs any exemption:
    it passes every checker rule, same as the round-one palettes.
    """
    from garage.themes.contrast import contrast_ratio, contrast_ratio_hex

    assert contrast_ratio_hex("#a06a14", "#f7f5f0") >= 3.0  # rim/bg: passes fine
    assert contrast_ratio((200, 120, 0), (247, 245, 240)) == pytest.approx(3.14, abs=0.01)
    assert validate_theme(LANTERN) == []


def test_missing_theme_yaml(tmp_path: Path) -> None:
    assert validate_theme(tmp_path) == ["missing: theme.yaml"]


# -- structural rules: one failing case each ---------------------------------


@pytest.mark.parametrize("key", ["name", "light", "dark", "type", "radius", "motion", "sounds"])
def test_missing_required_top_key(theme: Path, key: str) -> None:
    data = lantern_theme()
    del data[key]
    write_theme(theme, data)
    assert f"missing: {key}" in validate_theme(theme)


def test_unknown_top_level_key_refused(theme: Path) -> None:
    data = lantern_theme()
    data["extra"] = "nope"
    write_theme(theme, data)
    assert "shape: <root>" in validate_theme(theme)


@pytest.mark.parametrize("name", ["", "   ", "x" * 81, 7])
def test_invalid_name_refused(theme: Path, name: object) -> None:
    data = lantern_theme()
    data["name"] = name
    write_theme(theme, data)
    assert "shape: name" in validate_theme(theme)


@pytest.mark.parametrize("avatar", ["Arcade", "has space", "", "x" * 41])
def test_invalid_avatar_hint_refused(theme: Path, avatar: object) -> None:
    data = lantern_theme()
    data["avatar"] = avatar
    write_theme(theme, data)
    assert "shape: avatar" in validate_theme(theme)


def test_valid_avatar_hint_accepted(theme: Path) -> None:
    data = lantern_theme()
    data["avatar"] = "arcade"
    write_theme(theme, data)
    assert "shape: avatar" not in validate_theme(theme)


@pytest.mark.parametrize("variant", ["light", "dark"])
def test_variant_wrong_shape_refused(theme: Path, variant: str) -> None:
    data = lantern_theme()
    data[variant] = {"colors": {**data[variant]["colors"]}, "extra": 1}
    write_theme(theme, data)
    assert f"missing: {variant}" in validate_theme(theme)


@pytest.mark.parametrize("variant", ["light", "dark"])
def test_variant_missing_colour_key_refused(theme: Path, variant: str) -> None:
    data = lantern_theme()
    del data[variant]["colors"]["text"]
    write_theme(theme, data)
    assert f"shape: {variant}.colors" in validate_theme(theme)


@pytest.mark.parametrize("variant", ["light", "dark"])
def test_variant_extra_colour_key_refused(theme: Path, variant: str) -> None:
    data = lantern_theme()
    data[variant]["colors"]["not-a-real-key"] = "#000000"
    write_theme(theme, data)
    assert f"shape: {variant}.colors" in validate_theme(theme)


def test_bad_hex_colour_refused(theme: Path) -> None:
    data = lantern_theme()
    data["light"]["colors"]["text"] = "not-a-hex"
    write_theme(theme, data)
    assert "shape: light.colors.text" in validate_theme(theme)


@pytest.mark.parametrize("lamp", ["999 0 0", "1 2", "red green blue", 5])
def test_bad_lamp_refused(theme: Path, lamp: object) -> None:
    data = lantern_theme()
    data["light"]["colors"]["lamp"] = lamp
    write_theme(theme, data)
    assert "shape: light.colors.lamp" in validate_theme(theme)


@pytest.mark.parametrize("value", [-0.1, 1.1, True, "0.5"])
def test_bad_glow_strength_refused(theme: Path, value: object) -> None:
    data = lantern_theme()
    data["light"]["colors"]["glow-strength"] = value
    write_theme(theme, data)
    assert "shape: light.colors.glow-strength" in validate_theme(theme)


def test_bad_scrim_refused(theme: Path) -> None:
    data = lantern_theme()
    data["light"]["colors"]["scrim"] = "#1f1d1a"  # 6-hex, not 8-hex alpha
    write_theme(theme, data)
    assert "shape: light.colors.scrim" in validate_theme(theme)


@pytest.mark.parametrize("value", ["banana", "", "1px 2px"])
def test_bad_shadow_refused(theme: Path, value: str) -> None:
    data = lantern_theme()
    data["light"]["colors"]["shadow-1"] = value
    write_theme(theme, data)
    assert "shape: light.colors.shadow-1" in validate_theme(theme)


def test_wrong_font_refused(theme: Path) -> None:
    data = lantern_theme()
    data["type"]["font"] = "Arial, sans-serif"
    write_theme(theme, data)
    assert "font: type.font" in validate_theme(theme)


def test_radius_out_of_order_refused(theme: Path) -> None:
    data = lantern_theme()
    data["radius"]["sm"] = 20  # now sm > md
    write_theme(theme, data)
    assert "range: radius" in validate_theme(theme)


def test_radius_negative_refused(theme: Path) -> None:
    data = lantern_theme()
    data["radius"]["sm"] = -1
    write_theme(theme, data)
    assert "range: radius.sm" in validate_theme(theme)


def test_radius_missing_key_refused(theme: Path) -> None:
    data = lantern_theme()
    del data["radius"]["pill"]
    write_theme(theme, data)
    assert "shape: radius" in validate_theme(theme)


def test_motion_duration_over_cap_refused(theme: Path) -> None:
    data = lantern_theme()
    data["motion"]["duration-instant"] = 2001
    write_theme(theme, data)
    assert "range: motion.duration-instant" in validate_theme(theme)


def test_motion_breath_over_cap_refused(theme: Path) -> None:
    data = lantern_theme()
    data["motion"]["breath"] = 2501
    write_theme(theme, data)
    assert "range: motion.breath" in validate_theme(theme)


def test_motion_ease_not_cubic_bezier_refused(theme: Path) -> None:
    data = lantern_theme()
    data["motion"]["ease-out"] = "linear"
    write_theme(theme, data)
    assert "shape: motion.ease-out" in validate_theme(theme)


def test_sounds_missing_key_refused(theme: Path) -> None:
    data = lantern_theme()
    del data["sounds"]["done"]
    write_theme(theme, data)
    assert "shape: sounds" in validate_theme(theme)


def test_sounds_bad_value_refused(theme: Path) -> None:
    data = lantern_theme()
    data["sounds"]["done"] = ""
    write_theme(theme, data)
    assert "shape: sounds.done" in validate_theme(theme)


# -- §2 contrast rules: every pair, failing in both light and dark ----------


@pytest.mark.parametrize("variant", ["light", "dark"])
@pytest.mark.parametrize("fg_key,bg_keys", [*TEXT_PAIRS, *UI_PAIRS])
def test_contrast_pair_refused_in_each_variant(
    theme: Path, variant: str, fg_key: str, bg_keys: tuple[str, ...]
) -> None:
    data = lantern_theme()
    bg_key = bg_keys[0]
    data[variant]["colors"][fg_key] = data[variant]["colors"][bg_key]
    write_theme(theme, data)
    errors = validate_theme(theme)
    assert f"contrast: {variant}.colors.{fg_key}/{bg_key}" in errors


def test_text_ratio_just_under_4_5_is_refused(theme: Path) -> None:
    """`#777777` on `#ffffff` is ~4.48:1 -- above the 3:1 UI floor but below
    the real 4.5:1 text floor. Kills a mutant that lowers `TEXT_RATIO` to
    3.0 (a pair like this would wrongly pass)."""
    data = lantern_theme()
    data["light"]["colors"]["bg"] = "#ffffff"
    data["light"]["colors"]["text"] = "#777777"
    write_theme(theme, data)
    assert "contrast: light.colors.text/bg" in validate_theme(theme)


@pytest.mark.parametrize("variant", ["light", "dark"])
def test_lamp_bg_contrast_refused_in_each_variant(theme: Path, variant: str) -> None:
    data = lantern_theme()
    bg_hex = data[variant]["colors"]["bg"]
    r, g, b = hex_rgb(bg_hex) or (0, 0, 0)
    data[variant]["colors"]["lamp"] = f"{r} {g} {b}"
    write_theme(theme, data)
    errors = validate_theme(theme)
    assert f"contrast: {variant}.colors.lamp/bg" in errors


# -- parity table -------------------------------------------------------------
#
# Hard-coded verdicts for what `docs/t23/agent_core_theme_pack.py`'s
# `validate_theme_bytes` would return on the same input, worked out by
# reading that module (not imported -- contract §3 forbids playbooks
# depending the other way, and agent-core cannot import us either).
# `True` = the mirror's `validate_theme_bytes(...) == []` (pass).


def _mutate(mutator: Any) -> dict[str, Any]:
    data = lantern_theme()
    mutator(data)
    return data


PARITY_CASES: list[Any] = [
    # Lantern now passes every check (light lamp -> `200 120 0`, owner
    # decision) -- the mirror runs the identical WCAG formula, so an
    # unmodified pack passes there too.
    pytest.param(lambda d: None, True, id="lantern unchanged"),
    pytest.param(lambda d: d.pop("dark"), False, id="dark block absent"),
    pytest.param(lambda d: d.__setitem__("extra", 1), False, id="unknown top-level key"),
    pytest.param(
        lambda d: d["light"]["colors"].__setitem__("bogus", "#000000"),
        False,
        id="extra colour key in light.colors",
    ),
    pytest.param(lambda d: d["type"].__setitem__("font", "Arial"), False, id="type.font changed"),
    pytest.param(
        lambda d: d["radius"].__setitem__("sm", 999),
        False,
        id="radius order broken (sm > md)",
    ),
    pytest.param(
        lambda d: d["motion"].__setitem__("duration-fast", 2001),
        False,
        id="motion duration over the 2000ms cap",
    ),
    pytest.param(
        lambda d: d["light"]["colors"].__setitem__("text", d["light"]["colors"]["bg"]),
        False,
        id="text on bg contrast collapsed (light)",
    ),
]


@pytest.mark.parametrize("mutator,mirror_pass", PARITY_CASES)
def test_parity_with_agent_core_mirror(theme: Path, mutator: Any, mirror_pass: bool) -> None:
    data = _mutate(mutator)
    write_theme(theme, data)
    ours_pass = validate_theme(theme) == []
    assert ours_pass == mirror_pass


def test_shadow_strictness_is_a_documented_mirror_diff(theme: Path) -> None:
    """`docs/formats.md` calls `shadow-1`/`shadow-2` "a valid CSS box-shadow
    value string"; the agent-core mirror we read only checks length
    (1-200 chars), so it would *pass* a nonsense string like this one. We
    follow the stricter contract wording instead (contract §3) -- see
    `mirror_diffs` in the PR body. This is the one deliberate place our
    verdict and the mirror's verdict would disagree.
    """
    data = lantern_theme()
    data["light"]["colors"]["shadow-1"] = "definitely not a css box-shadow"
    write_theme(theme, data)
    assert any(e.startswith("shape: light.colors.shadow-1") for e in validate_theme(theme))
    # The mirror's own check (`1 <= len(value) <= 200`, no syntax check)
    # would have accepted this same string as-is.
    assert 1 <= len(data["light"]["colors"]["shadow-1"]) <= 200


def test_deep_copy_guard_does_not_alias_fixtures() -> None:
    # Sanity check for this test module's own helper: every test above
    # mutates a *fresh* `lantern_theme()` dict, never a shared one.
    a = lantern_theme()
    b = lantern_theme()
    a["name"] = "changed"
    assert b["name"] == "Lantern"
    assert copy.deepcopy(a) is not a
