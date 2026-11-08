"""Render a character into the fixed-grid avatar pack.

Defaults (`COLUMNS`, `FPS`, no extra rows) reproduce today's standard-tier
output unchanged. `render_pack` also accepts the T46 animated-tier knobs —
`frames` (4-12), `fps` (6-12) and `extra_states` (`idle_variant_1`, ...,
optionally `celebrate`) — see docs/t46/formats-avatar.md.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import yaml
from PIL import Image, ImageDraw, ImageFont

from .grid import COLS as COLUMNS
from .grid import (
    FPS,
    FRAME,
    FRAME_MS,
    MAX_ANIMATED_FPS,
    MAX_FRAMES,
    MIN_ANIMATED_FPS,
    MIN_FRAMES,
    STATES,
)
from .pixel import Anchors, Palette, hex_to_rgba, rgb_to_hex, rgba_pixels


class Character(Protocol):
    @property
    def name(self) -> str: ...
    @property
    def artist(self) -> str: ...
    @property
    def anchors(self) -> Anchors: ...
    @property
    def palette(self) -> Palette: ...
    def draw_frame(self, state: str, frame: int) -> Image.Image: ...


@dataclass(frozen=True)
class PackResult:
    out_dir: Path
    files: tuple[Path, ...]
    palette_size: int


def save_gif(frames: list[Image.Image], path: Path, frame_ms: int = FRAME_MS) -> None:
    pixel_lists = [rgba_pixels(fr) for fr in frames]
    colors: set[tuple[int, int, int]] = set()
    for pixels in pixel_lists:
        for r, g, b, a in pixels:
            assert a in (0, 255), "frames must be binary alpha for GIF"
            if a == 255:
                colors.add((r, g, b))
    key = (255, 0, 255)
    palette = [key] + sorted(colors)
    assert len(palette) <= 256
    idx = {c: i + 1 for i, c in enumerate(sorted(colors))}
    flat: list[int] = []
    for c in palette:
        flat.extend(c)
    flat.extend([0, 0, 0] * (256 - len(palette)))
    p_frames = []
    for pixels in pixel_lists:
        data = bytes(0 if a == 0 else idx[(r, g, b)] for r, g, b, a in pixels)
        im = Image.frombytes("P", (FRAME, FRAME), data)
        im.putpalette(flat)
        im.info["transparency"] = 0
        p_frames.append(im)
    p_frames[0].save(
        path,
        save_all=True,
        append_images=p_frames[1:],
        duration=[frame_ms] * len(p_frames),
        loop=0,
        disposal=2,
        transparency=0,
        optimize=False,
    )


def build_preview(
    frames: dict[str, list[Image.Image]],
    bg_hex: str,
    fg_hex: str,
    *,
    rows: Sequence[str] = STATES,
    columns: int = COLUMNS,
) -> Image.Image:
    pad, label_w, gap = 12, 128, 6
    w = pad + label_w + columns * FRAME + (columns - 1) * gap + pad
    h = pad + len(rows) * FRAME + (len(rows) - 1) * gap + pad
    img = Image.new("RGBA", (w, h), hex_to_rgba(bg_hex))
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    for r, state in enumerate(rows):
        y = pad + r * (FRAME + gap)
        draw.text((pad, y + FRAME // 2 - 6), state, fill=hex_to_rgba(fg_hex), font=font)
        for c, fr in enumerate(frames[state]):
            x = pad + label_w + c * (FRAME + gap)
            img.alpha_composite(fr, (x, y))
    return img


PREVIEW_64_STATES = ["idle", "asking", "paused"]


def build_preview_64(frames: dict[str, list[Image.Image]], bg_hex: str, fg_hex: str) -> Image.Image:
    """Frame 0 of a few states at 64x64 (nearest) in row 1, the same at 128 in row 2."""
    pad, gap, label_gap, label_h = 16, 16, 4, 12
    n = len(PREVIEW_64_STATES)
    w = pad + n * FRAME + (n - 1) * gap + pad
    h = pad + (64 + label_gap + label_h) + gap + (FRAME + label_gap + label_h) + pad
    img = Image.new("RGBA", (w, h), hex_to_rgba(bg_hex))
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    y = pad
    for size in (64, FRAME):
        for i, state in enumerate(PREVIEW_64_STATES):
            fr = frames[state][0]
            if size != FRAME:
                fr = fr.resize((size, size), Image.Resampling.NEAREST)
            x = pad + i * (size + gap)
            img.alpha_composite(fr, (x, y))
            draw.text(
                (x, y + size + label_gap), f"{state} {size}px", fill=hex_to_rgba(fg_hex), font=font
            )
        y += size + label_gap + label_h + gap
    return img


def render_pack(
    character: Character,
    out_dir: str | Path,
    *,
    frames: int = COLUMNS,
    fps: int = FPS,
    extra_states: Sequence[str] = (),
) -> PackResult:
    """Draw every frame for the fixed eight states plus any animated-tier
    extra rows. The palette declaration must cover every opaque pixel.

    Called with no keyword arguments this reproduces today's standard-tier
    pack byte-for-byte. Passing `frames` (4-12), `fps` (6-12) and/or
    `extra_states` (`idle_variant_1`, ..., optionally `celebrate`, after the
    fixed eight) opts the pack into `tier: animated`.
    """
    animated = frames != COLUMNS or fps != FPS or bool(extra_states)
    if animated:
        if not MIN_FRAMES <= frames <= MAX_FRAMES:
            raise ValueError(f"frames must be {MIN_FRAMES}..{MAX_FRAMES} for the animated tier")
        if not MIN_ANIMATED_FPS <= fps <= MAX_ANIMATED_FPS:
            raise ValueError(
                f"fps must be {MIN_ANIMATED_FPS}..{MAX_ANIMATED_FPS} for the animated tier"
            )
    rows = (*STATES, *extra_states)
    out_dir = Path(out_dir)
    sheet = Image.new("RGBA", (FRAME * frames, FRAME * len(rows)))
    frame_images: dict[str, list[Image.Image]] = {}
    used: set[str] = set()
    declared = {c.upper() for c in character.palette.values()}
    for row, state in enumerate(rows):
        frame_images[state] = []
        for index in range(frames):
            frame = character.draw_frame(state, index).convert("RGBA")
            if frame.size != (FRAME, FRAME):
                raise ValueError(f"frame size: {state}[{index}] must be 128x128")
            pixels = rgba_pixels(frame)
            if any(a not in (0, 255) for _, _, _, a in pixels):
                raise ValueError(f"frame alpha: {state}[{index}] must be binary")
            used.update(rgb_to_hex((r, g, b)) for r, g, b, a in pixels if a == 255)
            frame_images[state].append(frame)
            sheet.paste(frame, (index * FRAME, row * FRAME))
    if not used <= declared:
        raise ValueError("frame colour: pixel missing from character palette")
    if not 1 <= len(used) <= 255:
        raise ValueError("frame palette: GIF requires 1..255 opaque colours")
    out_dir.mkdir(parents=True, exist_ok=True)
    sheet.save(out_dir / "sheet.png")
    manifest: dict[str, object] = {
        "name": character.name,
        "artist": character.artist,
        "grid": {"frame": FRAME, "columns": frames, "rows": list(rows), "fps": fps},
        "palette": sorted(used),
        "anchors": character.anchors,
    }
    if animated:
        manifest["tier"] = "animated"
        manifest["frames"] = frames
        manifest["fps"] = fps
    (out_dir / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    names = ["sheet.png", "manifest.yaml"]
    for state in rows:
        save_gif(frame_images[state], out_dir / f"{state}.gif", round(1000 / fps))
        names.append(f"{state}.gif")
    for name, bg, fg in (
        ("preview-light.png", "#F4F1EA", "#2B1B14"),
        ("preview-dark.png", "#1C1E24", "#F4F1EA"),
    ):
        build_preview(frame_images, bg, fg, rows=rows, columns=frames).save(out_dir / name)
        names.append(name)
    build_preview_64(frame_images, "#1C1E24", "#F4F1EA").save(out_dir / "preview-64-dark.png")
    names.append("preview-64-dark.png")
    return PackResult(out_dir, tuple(out_dir / name for name in names), len(used))
