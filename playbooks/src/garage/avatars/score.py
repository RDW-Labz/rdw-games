"""Advisory measurements, never an automatic acceptance or rejection decision.

Bars: zero validator errors; no more colours than Beacon (77); all 32 anchor
checks; <=1% body silhouette drift; 20..85% coverage at 64px; >=3:1 outline/rim
contrast on each background. Credits/minutes are reported without a quality bar.
Body means the status band's horizontal span from its top to the baseline;
colour animation, faces, handles and arms outside that span do not count as drift.
Anchor checks measure opaque status coverage and the common dark outline baseline;
chat is a shared metadata point, checked for bounds only (no invented visual marker).
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import yaml
from PIL import Image

from .grid import COLS, DARK_BG, FRAME, LIGHT_BG, SHEET, STATES
from .pixel import hex_to_rgb, rgba_pixels
from .validate import record, validate_pack

BEACON_PALETTE_SIZE = 77
RGB = tuple[int, int, int]


@dataclass(frozen=True)
class RunRecord:
    credits: float
    minutes: float

    def __post_init__(self) -> None:
        if any(not math.isfinite(v) or v < 0 for v in (self.credits, self.minutes)):
            raise ValueError("run credits and minutes must be finite and non-negative")


@dataclass(frozen=True)
class ScoreRow:
    name: str
    value: str
    bar: str | None
    passed: bool | None


@dataclass(frozen=True)
class Score:
    rows: tuple[ScoreRow, ...]

    def to_markdown(self) -> str:
        lines = ["| Measure | Value | Bar | Result |", "| --- | --- | --- | --- |"]
        for row in self.rows:
            result = "—" if row.passed is None else "pass" if row.passed else "fail"
            value = row.value.replace("|", "\\|").replace("\n", "; ")
            lines.append(f"| {row.name} | {value} | {row.bar or '—'} | {result} |")
        return "\n".join(lines)


def luminance(rgb: RGB) -> float:
    def linear(channel: int) -> float:
        s = channel / 255
        return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = (linear(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: RGB, b: RGB) -> float:
    x, y = sorted((luminance(a), luminance(b)))
    return (y + 0.05) / (x + 0.05)


def _outline_colours(image: Image.Image) -> list[RGB]:
    """Common colours within two pixels of transparency at 64px (outline + rim)."""
    pixels = rgba_pixels(image)
    counts: Counter[RGB] = Counter()
    for y in range(64):
        for x in range(64):
            r, g, b, a = pixels[y * 64 + x]
            if a != 255:
                continue
            if any(
                not (0 <= x + dx < 64 and 0 <= y + dy < 64)
                or pixels[(y + dy) * 64 + x + dx][3] == 0
                for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2))
            ):
                counts[(r, g, b)] += 1
    return [c for c, n in counts.most_common() if n >= max(4, sum(counts.values()) * 0.05)]


def score_pack(directory: str | Path, run: RunRecord | None = None) -> Score:
    directory = Path(directory)
    errors = validate_pack(directory)
    rows = [
        ScoreRow(
            "Validator errors",
            str(len(errors)) + (": " + "; ".join(errors) if errors else ""),
            "0",
            not errors,
        )
    ]
    try:
        with Image.open(directory / "sheet.png") as source:
            sheet = source.convert("RGBA")
        manifest = record(yaml.safe_load((directory / "manifest.yaml").read_text()))
    except (OSError, ValueError, UnicodeError, yaml.YAMLError, Image.DecompressionBombError):
        sheet = Image.new("RGBA", (0, 0))
        manifest = {}
    used = {(r, g, b) for r, g, b, a in rgba_pixels(sheet) if a == 255}
    declared = manifest.get("palette")
    count = max(len(used), len(declared) if isinstance(declared, list) else 0)
    rows.append(
        ScoreRow(
            "Palette size vs Beacon",
            f"{count} / {BEACON_PALETTE_SIZE}",
            "1..77",
            1 <= count <= BEACON_PALETTE_SIZE,
        )
    )
    frames = (
        [
            sheet.crop((c * FRAME, r * FRAME, (c + 1) * FRAME, (r + 1) * FRAME))
            for r in range(len(STATES))
            for c in range(COLS)
        ]
        if sheet.size == SHEET
        else []
    )
    anchors = record(manifest.get("anchors"))
    light = record(anchors.get("status_light"))
    anchor_valid = not any(e.startswith(("anchor:", "missing: anchors")) for e in errors)
    consistent = 0
    drift = 1.0
    if frames and anchor_valid:
        x, y, w, h = (int(light[k]) for k in ("x", "y", "w", "h"))
        baseline = int(anchors["baseline"])
        dark: Counter[RGB] = Counter(
            (r, g, b)
            for frame in frames
            for r, g, b, a in rgba_pixels(frame)
            if a == 255 and luminance((r, g, b)) < 0.1
        )
        outline = dark.most_common(1)[0][0] if dark else None
        masks: list[set[int]] = []
        for frame in frames:
            pixels = rgba_pixels(frame)
            bottom = max(
                (
                    i // FRAME
                    for i, (r, g, b, a) in enumerate(pixels)
                    if a == 255 and (r, g, b) == outline
                ),
                default=-1,
            )
            solid = all(
                pixels[yy * FRAME + xx][3] == 255
                for yy in range(y, y + h)
                for xx in range(x, x + w)
            )
            consistent += solid and bottom == baseline
            masks.append(
                {
                    yy * FRAME + xx
                    for yy in range(y, baseline + 1)
                    for xx in range(x, x + w)
                    if pixels[yy * FRAME + xx][3] == 255
                }
            )
        # Loop transitions within each state plus comparisons to the first frame across states.
        pairs = [
            (masks[r * COLS + c], masks[r * COLS + (c + 1) % COLS])
            for r in range(len(STATES))
            for c in range(COLS)
        ]
        pairs += [(masks[0], mask) for mask in masks[1:]]
        drift = max(len(a ^ b) / max(1, len(a | b)) for a, b in pairs)
    rows.append(
        ScoreRow("Anchor consistency", f"{consistent}/32 frames", "32/32", consistent == 32)
    )
    rows.append(ScoreRow("Body silhouette drift", f"{drift:.2%}", "<=1%", drift <= 0.01))
    coverages: list[float] = []
    contrasts: dict[str, list[float]] = {"dark": [], "light": []}
    for frame in frames:
        small = frame.resize((64, 64), Image.Resampling.NEAREST)
        coverages.append(sum(a == 255 for _, _, _, a in rgba_pixels(small)) / 4096)
        outline_colours = _outline_colours(small)
        for label, bg in (("dark", DARK_BG), ("light", LIGHT_BG)):
            contrasts[label].append(
                max((contrast(c, hex_to_rgb(bg)) for c in outline_colours), default=1.0)
            )
    low, high = (min(coverages), max(coverages)) if coverages else (0.0, 0.0)
    rows.append(
        ScoreRow(
            "64 px silhouette coverage",
            f"{low:.1%}..{high:.1%}",
            "20..85%",
            0.2 <= low <= high <= 0.85,
        )
    )
    for label, values in contrasts.items():
        value = min(values, default=1.0)
        rows.append(
            ScoreRow(f"64 px outline/rim contrast ({label})", f"{value:.2f}:1", ">=3:1", value >= 3)
        )
    rows.extend(
        (
            ScoreRow("Credits", f"{run.credits:g}" if run else "not recorded", None, None),
            ScoreRow("Minutes", f"{run.minutes:g}" if run else "not recorded", None, None),
        )
    )
    return Score(tuple(rows))
