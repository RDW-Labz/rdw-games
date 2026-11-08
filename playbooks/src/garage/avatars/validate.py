"""Mirror the Rig's avatarPack.ts rules, returning stable code/path errors."""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import yaml
from PIL import Image

from .grid import (
    COLS,
    FRAME,
    MAX_ANIMATED_FPS,
    MAX_FRAMES,
    MAX_IDLE_VARIANTS,
    MIN_ANIMATED_FPS,
    MIN_FRAMES,
    STATES,
)
from .pixel import rgba_pixels


def record(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def inside(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and int(value) == value
        and 0 <= value < FRAME
    )


def in_range(value: object, low: float, high: float) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and int(value) == value
        and low <= value <= high
    )


def resolved_columns(value: object) -> int:
    """The sheet's expected column count: `value` itself when it is a valid
    4-12 frame count, else the standard-tier default (4)."""
    if (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and int(value) == value
        and MIN_FRAMES <= value <= MAX_FRAMES
    ):
        return int(value)
    return COLS


def valid_extra_rows(extra: list[object]) -> bool:
    """One or more `idle_variant_1`, `idle_variant_2`, ... (no gaps, at most
    `MAX_IDLE_VARIANTS`), then optionally `celebrate` — an empty tail (no
    extra rows) is also valid. A 9th `idle_variant_N` row is refused (§8.7)."""
    if not extra:
        return True
    index = 0
    while (
        index < len(extra)
        and index < MAX_IDLE_VARIANTS
        and extra[index] == f"idle_variant_{index + 1}"
    ):
        index += 1
    if index == 0:
        return False
    remaining = extra[index:]
    return not remaining or remaining == ["celebrate"]


def validate_pack(directory: str | Path) -> list[str]:
    """Empty means valid. Missing/unreadable inputs are errors, never a crash."""
    directory = Path(directory)
    errors: list[str] = []

    def fail(code: str, path: str) -> None:
        message = f"{code}: {path}"
        if message not in errors:
            errors.append(message)

    try:
        manifest = record(yaml.safe_load((directory / "manifest.yaml").read_text()))
    except (OSError, UnicodeError, yaml.YAMLError):
        fail("missing", "manifest.yaml")
        manifest = {}
    for key in ("name", "artist", "grid", "palette", "anchors"):
        if key not in manifest:
            fail("missing", key)
    for key in ("name", "artist"):
        if not isinstance(manifest.get(key), str) or not manifest[key].strip():
            fail("missing", key)

    tier = manifest.get("tier")
    if tier is not None and tier not in ("standard", "animated"):
        fail("grid", "tier")
    is_animated = tier == "animated"

    grid = record(manifest.get("grid"))
    rows = grid.get("rows")
    rows_prefix_ok = isinstance(rows, list) and rows[: len(STATES)] == list(STATES)
    columns = grid.get("columns")

    frames_value = manifest.get("frames")
    frames_present = frames_value is not None
    frames_out_of_range = not in_range(frames_value, MIN_FRAMES, MAX_FRAMES)
    if frames_present and (frames_out_of_range or frames_value != columns):
        fail("grid", "frames")

    columns_ok = (not frames_present and columns == COLS) or (
        frames_present and in_range(columns, MIN_FRAMES, MAX_FRAMES)
    )
    if grid.get("frame") != FRAME or not rows_prefix_ok or not columns_ok:
        fail("grid", "grid")

    fps = grid.get("fps")
    if not in_range(fps, 1, 12):
        fail("grid", "grid.fps")

    fps_value = manifest.get("fps")
    if fps_value is not None and (
        not in_range(fps_value, MIN_ANIMATED_FPS, MAX_ANIMATED_FPS) or fps_value != fps
    ):
        fail("grid", "fps")

    if rows_prefix_ok and isinstance(rows, list):
        extra = rows[len(STATES) :]
        if extra and not is_animated:
            fail("grid", "grid.rows")
        elif not valid_extra_rows(extra):
            fail("grid", "grid.rows")
        elif is_animated and not ("idle_variant_1" in extra and "celebrate" in extra):
            fail("grid", "grid.rows")

    anchors = record(manifest.get("anchors"))
    for key in ("status_light", "chat_button", "baseline"):
        if key not in anchors:
            fail("missing", f"anchors.{key}")
    light = record(anchors.get("status_light"))
    chat = record(anchors.get("chat_button"))
    if (
        not inside(light.get("x"))
        or not inside(light.get("y"))
        or any(
            type(light.get(k)) not in (int, float)
            or not math.isfinite(light[k])
            or light[k] <= 0
            or int(light[k]) != light[k]
            for k in ("w", "h")
        )
        or light["x"] + light["w"] > FRAME
        or light["y"] + light["h"] > FRAME
    ):
        fail("anchor", "anchors.status_light")
    if not inside(chat.get("x")) or not inside(chat.get("y")):
        fail("anchor", "anchors.chat_button")
    if not inside(anchors.get("baseline")):
        fail("anchor", "anchors.baseline")
    palette = manifest.get("palette")
    valid_palette = (
        isinstance(palette, list)
        and 1 <= len(palette) <= 256
        and all(isinstance(c, str) and re.fullmatch(r"#[\da-fA-F]{6}", c) for c in palette)
    )
    if not valid_palette:
        fail("palette", "palette")
    try:
        with Image.open(directory / "sheet.png") as source:
            image = source.convert("RGBA")
    except (OSError, ValueError, Image.DecompressionBombError):
        fail("pixels", "sheet.rgba")
        return errors
    expected_columns = resolved_columns(columns)
    expected_rows = len(rows) if isinstance(rows, list) and rows else len(STATES)
    expected_sheet = (FRAME * expected_columns, FRAME * expected_rows)
    if image.size != expected_sheet:
        fail("grid", "sheet")
        fail("pixels", "sheet.rgba")
        return errors
    colours = (
        {int(c[1:], 16) for c in palette} if valid_palette and isinstance(palette, list) else set()
    )
    pixels = rgba_pixels(image)
    if any(a not in (0, 255) for _, _, _, a in pixels):
        fail("alpha", "sheet.rgba")
    if any((r << 16 | g << 8 | b) not in colours for r, g, b, a in pixels if a == 255):
        fail("colour", "sheet.rgba")
    return errors
