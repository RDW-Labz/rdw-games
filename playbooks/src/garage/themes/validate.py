"""theme.yaml structural + contrast validator.

Mirrors `docs/t23/contract.md` §1 (keys) and §2 (contrast rules), and
`docs/t23/formats.md`'s "Theme pack -- theme.yaml" section, the authority on
the exact shapes. Same return style as `garage.avatars.validate.validate_pack`:
an empty list means the pack passed; missing/unreadable input is an error,
never a crash.

Kept in step with agent-core's own mirror (`anorak.theme_pack`,
`docs/t23/contract.md` §3) by contract, not by import -- agent-core cannot
depend on playbooks without a dependency cycle (`playbooks` already depends
on `agent-core`). Where this module and that mirror could reasonably read
the contract differently, this module follows `docs/formats.md`/`contract.md`
and the mismatch is called out in code comments below.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, Final

import yaml

from .contrast import contrast_ratio, contrast_ratio_hex, hex_rgb

#: Decision #167: Figtree only, every theme -- not overridable.
FONT_FIXED: Final = 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif'

#: `docs/formats.md`'s "colors" table, exactly the 20 keys every
#: `light.colors`/`dark.colors` block must carry, no more, no fewer.
COLOR_KEYS: Final[tuple[str, ...]] = (
    "bg",
    "surface",
    "surface-raised",
    "border",
    "hairline",
    "text",
    "text-muted",
    "accent",
    "accent-text",
    "focus",
    "link",
    "ok",
    "needs-you",
    "rim",
    "lamp",
    "glow-strength",
    "error",
    "paused",
    "scrim",
    "shadow-1",
    "shadow-2",
)

REQUIRED_TOP_KEYS: Final = ("name", "light", "dark", "type", "radius", "motion", "sounds")
OPTIONAL_TOP_KEYS: Final = ("avatar",)

#: Pack id / `avatar` hint pattern, contract §1 (same shape as an avatar id).
_ID_RE: Final = re.compile(r"[a-z0-9-]{1,40}")
_HEX_RE: Final = re.compile(r"#[0-9a-fA-F]{6}")
_HEX_ALPHA_RE: Final = re.compile(r"#[0-9a-fA-F]{8}")
_LAMP_RE: Final = re.compile(r"(\d{1,3}) (\d{1,3}) (\d{1,3})")
_CUBIC_BEZIER_RE: Final = re.compile(
    r"cubic-bezier\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,"
    r"\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)"
)
#: A CSS length used in `box-shadow`: bare `0`, or a signed number with `px`.
_SHADOW_LENGTH: Final = r"(?:0|-?\d+(?:\.\d+)?px)"
#: One `box-shadow` layer: optional `inset`, 2-4 lengths (offset-x, offset-y,
#: optional blur, optional spread), then a `#RRGGBB`/`#RRGGBBAA` colour.
#: `docs/formats.md` calls shadow-1/2 "a valid CSS box-shadow value string";
#: this is a real (if partial) syntax check.
_SHADOW_LAYER_RE: Final = re.compile(
    rf"(?:inset\s+)?(?:{_SHADOW_LENGTH}\s+){{1,3}}{_SHADOW_LENGTH}\s+"
    rf"#[0-9a-fA-F]{{6}}(?:[0-9a-fA-F]{{2}})?"
)

_MOTION_MS_KEYS: Final = (
    "duration-instant",
    "duration-fast",
    "duration-base",
    "duration-slow",
    "duration-light",
)
_MOTION_EASE_KEYS: Final = ("ease-out", "ease-in", "ease-standard")
_MOTION_KEYS: Final = (*_MOTION_MS_KEYS, "breath", *_MOTION_EASE_KEYS)
_RADIUS_KEYS: Final = ("sm", "md", "lg", "pill")
_SOUND_KEYS: Final = ("needs_you", "done", "problem")

#: Contract §2: 4.5:1 text pairs and 3:1 UI pairs, each foreground checked
#: against every listed background, in both `light.colors` and `dark.colors`.
TEXT_PAIRS: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    ("text", ("bg", "surface", "surface-raised")),
    ("text-muted", ("bg", "surface", "surface-raised")),
    ("accent-text", ("accent",)),
    ("needs-you", ("bg", "surface", "surface-raised")),
    ("link", ("bg", "surface", "surface-raised")),
    ("ok", ("bg", "surface", "surface-raised")),
    ("error", ("bg", "surface", "surface-raised")),
    ("paused", ("bg", "surface", "surface-raised")),
)
UI_PAIRS: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    ("border", ("bg", "surface", "surface-raised")),
    ("focus", ("bg", "surface", "surface-raised")),
    ("rim", ("bg", "surface", "surface-raised")),
)
TEXT_RATIO: Final = 4.5
UI_RATIO: Final = 3.0

FailFn = Callable[[str, str], None]


def _record(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _valid_hex(value: object) -> bool:
    return isinstance(value, str) and _HEX_RE.fullmatch(value) is not None


def _valid_hex_alpha(value: object) -> bool:
    return isinstance(value, str) and _HEX_ALPHA_RE.fullmatch(value) is not None


def _lamp_rgb(value: object) -> tuple[int, int, int] | None:
    if not isinstance(value, str):
        return None
    match = _LAMP_RE.fullmatch(value)
    if match is None:
        return None
    r, g, b = (int(part) for part in match.groups())
    if not (0 <= r <= 255 and 0 <= g <= 255 and 0 <= b <= 255):
        return None
    return r, g, b


def _valid_lamp(value: object) -> bool:
    return _lamp_rgb(value) is not None


def _valid_glow_strength(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return 0.0 <= float(value) <= 1.0


def _valid_shadow(value: object) -> bool:
    if not isinstance(value, str) or not 1 <= len(value) <= 200:
        return False
    layers = [layer.strip() for layer in value.split(",")]
    return all(_SHADOW_LAYER_RE.fullmatch(layer) is not None for layer in layers)


_COLOR_VALIDATORS: Final[dict[str, Callable[[object], bool]]] = {
    "lamp": _valid_lamp,
    "glow-strength": _valid_glow_strength,
    "scrim": _valid_hex_alpha,
    "shadow-1": _valid_shadow,
    "shadow-2": _valid_shadow,
}


def _valid_int(value: object, *, minimum: int, maximum: int | None = None) -> bool:
    if not isinstance(value, int) or isinstance(value, bool):
        return False
    if value < minimum:
        return False
    return maximum is None or value <= maximum


def _validate_variant(m: dict[str, Any], variant: str, fail: FailFn) -> dict[str, Any] | None:
    """Validate `m[variant]` (`{"colors": {...}}`) shape only -- contrast is
    checked separately, once both variants' shapes are known good. Returns
    the variant's `colors` mapping on success, else `None`."""
    if variant not in m:
        return None
    block = m[variant]
    if not isinstance(block, dict) or set(block) != {"colors"}:
        fail("missing", variant)
        return None
    colors = block["colors"]
    if not isinstance(colors, dict) or set(colors) != set(COLOR_KEYS):
        fail("shape", f"{variant}.colors")
        return None
    ok = True
    for key in COLOR_KEYS:
        validator = _COLOR_VALIDATORS.get(key, _valid_hex)
        if not validator(colors[key]):
            fail("shape", f"{variant}.colors.{key}")
            ok = False
    return colors if ok else None


def _validate_type(value: object, fail: FailFn) -> None:
    block = _record(value)
    if set(block) != {"font"} or block.get("font") != FONT_FIXED:
        fail("font", "type.font")


def _validate_radius(value: object, fail: FailFn) -> None:
    block = _record(value)
    if set(block) != set(_RADIUS_KEYS):
        fail("shape", "radius")
        return
    for key in _RADIUS_KEYS:
        if not _valid_int(block[key], minimum=0):
            fail("range", f"radius.{key}")
    if all(_valid_int(block[key], minimum=0) for key in _RADIUS_KEYS):
        sm, md, lg, pill = (int(block[key]) for key in _RADIUS_KEYS)
        if not (sm <= md <= lg <= pill):
            fail("range", "radius")


def _validate_motion(value: object, fail: FailFn) -> None:
    block = _record(value)
    if set(block) != set(_MOTION_KEYS):
        fail("shape", "motion")
        return
    for key in _MOTION_MS_KEYS:
        if not _valid_int(block[key], minimum=0, maximum=2000):
            fail("range", f"motion.{key}")
    if not _valid_int(block["breath"], minimum=0, maximum=2500):
        fail("range", "motion.breath")
    for key in _MOTION_EASE_KEYS:
        candidate = block[key]
        if not isinstance(candidate, str) or _CUBIC_BEZIER_RE.fullmatch(candidate) is None:
            fail("shape", f"motion.{key}")


def _validate_sounds(value: object, fail: FailFn) -> None:
    block = _record(value)
    if set(block) != set(_SOUND_KEYS):
        fail("shape", "sounds")
        return
    for key in _SOUND_KEYS:
        candidate = block[key]
        if not isinstance(candidate, str) or not 1 <= len(candidate) <= 40:
            fail("shape", f"sounds.{key}")


def _check_pairs(
    colors: dict[str, Any],
    variant: str,
    fg_key: str,
    bg_keys: tuple[str, ...],
    floor: float,
    fail: FailFn,
) -> None:
    fg = colors.get(fg_key)
    for bg_key in bg_keys:
        bg = colors.get(bg_key)
        ratio = contrast_ratio_hex(fg, bg)
        if ratio is None or ratio < floor:
            fail("contrast", f"{variant}.colors.{fg_key}/{bg_key}")


def _check_contrast(colors: dict[str, Any], variant: str, fail: FailFn) -> None:
    for fg_key, bg_keys in TEXT_PAIRS:
        _check_pairs(colors, variant, fg_key, bg_keys, TEXT_RATIO, fail)
    for fg_key, bg_keys in UI_PAIRS:
        _check_pairs(colors, variant, fg_key, bg_keys, UI_RATIO, fail)
    # Decision #167: `lamp` as a solid colour (never through `glow-strength`)
    # against `bg`, 3:1 -- the one pair whose foreground is not itself a
    # `"#RRGGBB"` value.
    lamp_rgb = _lamp_rgb(colors.get("lamp"))
    bg_rgb = hex_rgb(colors.get("bg"))
    if lamp_rgb is None or bg_rgb is None or contrast_ratio(lamp_rgb, bg_rgb) < UI_RATIO:
        fail("contrast", f"{variant}.colors.lamp/bg")


def validate_theme(directory: str | Path) -> list[str]:
    """Empty means valid. Missing/unreadable input is an error, never a crash."""
    directory = Path(directory)
    errors: list[str] = []

    def fail(code: str, path: str) -> None:
        message = f"{code}: {path}"
        if message not in errors:
            errors.append(message)

    try:
        raw = (directory / "theme.yaml").read_text()
        data = yaml.safe_load(raw)
    except (OSError, UnicodeError, yaml.YAMLError):
        fail("missing", "theme.yaml")
        return errors

    m = _record(data)
    known_keys = set(REQUIRED_TOP_KEYS) | set(OPTIONAL_TOP_KEYS)
    for key in REQUIRED_TOP_KEYS:
        if key not in m:
            fail("missing", key)
    if any(key not in known_keys for key in m):
        fail("shape", "<root>")

    if "name" in m:
        name = m["name"]
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            fail("shape", "name")

    if "avatar" in m:
        avatar = m["avatar"]
        if not isinstance(avatar, str) or _ID_RE.fullmatch(avatar) is None:
            fail("shape", "avatar")

    light_colors = _validate_variant(m, "light", fail)
    dark_colors = _validate_variant(m, "dark", fail)

    if "type" in m:
        _validate_type(m["type"], fail)
    if "radius" in m:
        _validate_radius(m["radius"], fail)
    if "motion" in m:
        _validate_motion(m["motion"], fail)
    if "sounds" in m:
        _validate_sounds(m["sounds"], fail)

    if light_colors is not None:
        _check_contrast(light_colors, "light", fail)
    if dark_colors is not None:
        _check_contrast(dark_colors, "dark", fail)

    return errors
