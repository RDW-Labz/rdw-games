"""Build-time CLI: turn one character's per-state video frames into a "More motion" pack.

Input is one folder of PNG frames per state (from `extract_frames.swift`, one clip per state,
every clip shot on one flat key colour with a locked camera) plus the sprite base the clips
were started from. Output is an animated-tier pack (docs/t46/contract.md §1, §8): the fixed
eight states, then `idle_variant_1..N` (N <= 8) and `celebrate`, one sheet-wide `frames`
count (4-12) and `fps` (6-12).

Steps, all in plain code (no image model, no network, no credits):

1. key out the background (the key colour is read off the sprite base's border) with a soft
   alpha and a spill clamp, so the key colour never tints the character's edge;
2. pick the same number of frames from every clip, evenly spaced over the clip's own loop
   (the clip is cut where it comes back closest to its first frame, so a row loops cleanly);
3. crop every frame of every state with ONE shared box (the union of all picked frames,
   centred on the resting pose), so the character never jumps or rescales between states;
   with `fill` (0.80-0.90, decision #205) that one box is scaled so the tallest frame's
   outlined height, across every state in the pack, is that share of the cell, feet on the
   baseline and centred, like the busts; a move that would then leave the frame is refused,
   never clipped;
4. quantise every frame to one shared palette and give it portrait_to_pack's look: speck
   clean-up, dark 2 px outline, light rim, the status brooch at a fixed anchor, the same
   state props (bubbles, card, sparkles), grey for paused and dimmed grey for offline;
5. write the pack with `render_pack` (manifest.yaml + sheet.png + per-state GIFs) and run
   `validate_pack`.

Run with uv run from the repository root.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageMath

sys.path.insert(0, str(Path(__file__).resolve().parent))
import portrait_to_pack as p2p  # noqa: E402  (sibling build tool: its look is the style)

from garage.avatars.grid import (  # noqa: E402
    CELEBRATE,
    DARK_BG,
    FRAME,
    IDLE_VARIANT_PREFIX,
    LIGHT_BG,
    MAX_ANIMATED_FPS,
    MAX_FRAMES,
    MAX_IDLE_VARIANTS,
    MIN_ANIMATED_FPS,
    MIN_FRAMES,
    STATES,
)
from garage.avatars.pack import render_pack  # noqa: E402
from garage.avatars.pixel import (  # noqa: E402
    Anchors,
    Grid,
    add_rim,
    hex_to_rgb,
    iround,
    render_grid,
    rgb_to_hex,
)
from garage.avatars.validate import validate_pack  # noqa: E402

RGB = tuple[int, int, int]
Box = tuple[int, int, int, int]  # x0, y0, x1, y1 (x1/y1 exclusive, PIL style)
MAX_SHEET_BYTES = 2 * 1024 * 1024
NATIVE = FRAME  # one frame pixel per native pixel, as portrait_to_pack's default
RING = 2  # outline thickness
MARGIN = RING + 1  # outline plus 1 px rim
BOTTOM = (p2p.BASELINE + 1) - 1 - RING  # last content row, as portrait_to_pack
BOX_W, BOX_H = NATIVE - 2 * MARGIN, BOTTOM - MARGIN + 1
# Brooch tones for the extra rows (the fixed eight use portrait_to_pack's STATE_BAND).
EXTRA_BAND = {"idle_variant": ["dim"] * 4, CELEBRATE: ["mid", "bright", "white", "bright"]}
ALPHA_CUT = 128
MIN_FILL, MAX_FILL = 0.80, 0.90  # character height / cell height (decision #205)


# --- rows ---------------------------------------------------------------------------------


def pack_rows(names: Sequence[str]) -> list[str]:
    """Order the state folders as the contract's rows: the fixed eight, then idle_variant_1..N
    (no gaps, N <= 8), then celebrate. Every animated pack needs at least one idle variant and
    a celebrate row (§8.5); anything else is refused."""
    present = set(names)
    missing = [s for s in STATES if s not in present]
    if missing:
        raise ValueError(f"missing state folders: {', '.join(missing)}")
    variants = sorted(
        (n for n in present if n.startswith(IDLE_VARIANT_PREFIX)),
        key=lambda n: (
            int(n[len(IDLE_VARIANT_PREFIX) :]) if n[len(IDLE_VARIANT_PREFIX) :].isdigit() else -1
        ),
    )
    expected = [f"{IDLE_VARIANT_PREFIX}{i + 1}" for i in range(len(variants))]
    if not variants or variants != expected or len(variants) > MAX_IDLE_VARIANTS:
        raise ValueError(
            f"idle variants must be {IDLE_VARIANT_PREFIX}1..N with no gaps, N <= "
            f"{MAX_IDLE_VARIANTS}; got {sorted(variants)}"
        )
    if CELEBRATE not in present:
        raise ValueError("missing state folder: celebrate")
    unknown = present - set(STATES) - set(variants) - {CELEBRATE}
    if unknown:
        raise ValueError(f"unknown state folders: {', '.join(sorted(unknown))}")
    return [*STATES, *variants, CELEBRATE]


def load_clips(frames_dir: Path) -> dict[str, list[Path]]:
    names = [p.name for p in frames_dir.iterdir() if p.is_dir()]
    rows = pack_rows(names)
    clips = {row: sorted((frames_dir / row).glob("*.png")) for row in rows}
    for row, paths in clips.items():
        if not paths:
            raise ValueError(f"no PNG frames in {frames_dir / row}")
    return clips


# --- keying -------------------------------------------------------------------------------


def detect_key(base: Image.Image, border: int = 4) -> RGB:
    """The key colour: per-channel median of the base image's outer `border` pixels."""
    rgb = base.convert("RGB")
    w, h = rgb.size
    strips = [
        rgb.crop((0, 0, w, border)),
        rgb.crop((0, h - border, w, h)),
        rgb.crop((0, 0, border, h)),
        rgb.crop((w - border, 0, w, h)),
    ]
    channels: list[list[int]] = [[], [], []]
    for strip in strips:
        data = strip.tobytes()
        for i in range(0, len(data), 3):
            for c in range(3):
                channels[c].append(data[i + c])
    med = [sorted(ch)[len(ch) // 2] for ch in channels]
    return (med[0], med[1], med[2])


def key_out(image: Image.Image, key: RGB, low: float = 70.0, high: float = 160.0) -> Image.Image:
    """RGBA with the key colour removed: alpha 0 within `low` (RGB distance) of the key, 255
    beyond `high`, a ramp between; the key's own hue is clamped out of every pixel (spill)."""
    hi = [c for c in range(3) if key[c] > 127]
    lo = [c for c in range(3) if key[c] <= 127]
    if not hi or not lo:
        raise ValueError("key colour must be saturated (like magenta or green), not grey")
    rgb = image.convert("RGB")
    bands = dict(zip("rgb", rgb.split(), strict=True))
    kr, kg, kb = key
    low2, high2 = iround(low * low), iround(high * high)
    span = max(1, high2 - low2)

    def alpha_expr(a: dict[str, Any]) -> Any:
        dr, dg, db = a["r"] - kr, a["g"] - kg, a["b"] - kb
        d2 = dr * dr + dg * dg + db * db
        return a["min"](a["max"]((d2 - low2) * 255 / span, 0), 255)

    alpha = ImageMath.lambda_eval(alpha_expr, **bands).convert("L")
    names = "rgb"
    hi_names = [names[c] for c in hi]
    lo_names = [names[c] for c in lo]

    def spill_expr(a: dict[str, Any]) -> Any:
        top = a[hi_names[0]]
        for n in hi_names[1:]:
            top = a["min"](top, a[n])
        floor = a[lo_names[0]]
        for n in lo_names[1:]:
            floor = a["max"](floor, a[n])
        return a["max"](top - floor, 0)

    spill = ImageMath.lambda_eval(spill_expr, **bands)
    out = []
    for c, name in enumerate(names):
        band = bands[name]
        if c in hi:
            band = ImageMath.lambda_eval(
                lambda a: a["max"](a["x"] - a["s"], 0), x=band, s=spill
            ).convert("L")
        out.append(band)
    result = Image.merge("RGB", out).convert("RGBA")
    result.putalpha(alpha)
    return result


# --- frame picking ------------------------------------------------------------------------


def _signature(image: Image.Image) -> Image.Image:
    return image.convert("L").resize((32, 32), Image.Resampling.BILINEAR)


def _distance(a: Image.Image, b: Image.Image) -> float:
    diff = ImageChops.difference(a, b).tobytes()
    return sum(diff) / len(diff)


def loop_end(signatures: Sequence[Image.Image], tail: float = 0.25) -> int:
    """Index where the clip comes back closest to its first frame, searched in the last `tail`
    of the clip; frames [0, end) then play as a loop that wraps back to frame 0. Ties go to the
    later frame so a clip that barely moves keeps its full length."""
    n = len(signatures)
    if n < 2:
        return n
    start = max(1, min(n - 1, int(n * (1 - tail))))
    best, best_d = n, float("inf")
    for i in range(start, n):
        d = _distance(signatures[0], signatures[i])
        if d <= best_d:
            best, best_d = i, d
    return best if best >= 1 else n


def pick_frames(count: int, frames: int, end: int | None = None) -> list[int]:
    """`frames` indices evenly spaced over [0, end): the gap from the last pick back to
    frame 0 (== frame `end`) is the same as every other gap, so the row loops smoothly."""
    end = count if end is None else end
    if frames < 1 or end < frames:
        raise ValueError(f"cannot pick {frames} frames from a loop of {end}")
    return [min(end - 1, iround(k * end / frames)) for k in range(frames)]


# --- shared crop --------------------------------------------------------------------------


def opaque_box(image: Image.Image, speck: int = 3) -> Box | None:
    """Bounding box of the alpha >= 128 pixels after a morphological opening of size `speck`,
    which drops compression specks but keeps anything at least that thick (a wing tip)."""
    mask = image.getchannel("A").point(lambda a: 255 if a >= ALPHA_CUT else 0)
    if speck > 1:
        mask = mask.filter(ImageFilter.MinFilter(speck)).filter(ImageFilter.MaxFilter(speck))
    box = mask.getbbox()
    return None if box is None else (box[0], box[1], box[2], box[3])


def shared_box(boxes: Sequence[Box], centre_x: float) -> Box:
    """One crop for every frame of every state: the union of all boxes, widened to be
    symmetric about `centre_x` (the resting pose's centre) so the resting character sits
    in the middle of the frame."""
    if not boxes:
        raise ValueError("no opaque pixels in any frame")
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    half = max(centre_x - x0, x1 - centre_x)
    return (iround(centre_x - half), y0, iround(centre_x + half), y1)


@dataclass(frozen=True)
class Placement:
    """Where the shared box lands in the 128 px frame: scaled to fit, feet on the baseline."""

    box: Box
    scale: float
    out_w: int
    out_h: int
    ox: int
    oy: int


def check_fill(fill: float) -> None:
    if not MIN_FILL <= fill <= MAX_FILL:
        raise ValueError(f"fill must be {MIN_FILL:.2f}..{MAX_FILL:.2f} of the cell height")


def place(box: Box, fill: float | None = None, tallest_h: int | None = None) -> Placement:
    """Scale the shared box into the frame, feet on the baseline and centred.

    Without `fill` the box is as large as fits. With `fill` the scale is set by the tallest
    frame in the whole pack: `tallest_h` (source px, the visible bounding box height of the
    tallest single frame across every state; default the box's own height) plus the outline
    and rim becomes `fill` of the cell height, so the character is always drawn at the same
    size as the busts. That one scale and offset then apply to every frame (no per-frame
    jitter); a move that then leaves the frame (a jump above the top, a stretch past the
    sides) is refused rather than clipped: lower `fill` or re-make that clip."""
    w, h = box[2] - box[0], box[3] - box[1]
    if fill is None:
        scale = min(BOX_W / w, BOX_H / h)
    else:
        check_fill(fill)
        scale = (iround(fill * FRAME) - 2 * MARGIN) / (tallest_h or h)
        big_w, big_h = iround(w * scale), iround(h * scale)
        if big_w > BOX_W or big_h > BOX_H:
            raise ValueError(
                f"fill {fill:.2f} does not fit: the moves span {big_w}x{big_h} px and the "
                f"frame holds {BOX_W}x{BOX_H}. Use a lower fill or re-make the widest clip"
            )
    out_w, out_h = max(1, iround(w * scale)), max(1, iround(h * scale))
    return Placement(box, scale, out_w, out_h, (NATIVE - out_w) // 2, BOTTOM - out_h + 1)


def max_fill(box: Box, tallest_h: int) -> float:
    """The largest `fill` whose moves still fit the frame (may be below MIN_FILL)."""
    w, h = box[2] - box[0], box[3] - box[1]
    scale = min(BOX_W / w, BOX_H / h)
    return (tallest_h * scale + 2 * MARGIN) / FRAME


def grid_fill(grid: Grid) -> float:
    """Height of everything drawn in a native grid (outline and rim included) / the frame."""
    rows = [y for y, row in enumerate(grid) if any(t != "." for t in row)]
    return 0.0 if not rows else (max(rows) - min(rows) + 1) / NATIVE


def fit_frame(keyed: Image.Image, placement: Placement) -> Image.Image:
    """Crop with the shared box and scale (premultiplied, so edges never pick up the key)."""
    crop = keyed.crop(placement.box)
    small = crop.convert("RGBa").resize(
        (placement.out_w, placement.out_h), Image.Resampling.LANCZOS
    )
    canvas = Image.new("RGBA", (NATIVE, NATIVE), (0, 0, 0, 0))
    canvas.paste(small.convert("RGBA"), (placement.ox, placement.oy))
    return canvas


# --- palette and look ---------------------------------------------------------------------


def _enhance(image: Image.Image) -> Image.Image:
    rgb = ImageEnhance.Contrast(ImageEnhance.Color(image.convert("RGB")).enhance(1.2)).enhance(1.08)
    out = rgb.convert("RGBA")
    out.putalpha(image.getchannel("A"))
    return out


def _opaque_strip(images: Sequence[Image.Image]) -> tuple[Image.Image, list[list[int]]]:
    """All opaque pixels of `images` as one RGB strip, plus each image's opaque positions."""
    chunks: list[bytes] = []
    where: list[list[int]] = []
    for im in images:
        data = im.tobytes()
        pos = [i for i in range(len(data) // 4) if data[4 * i + 3] >= ALPHA_CUT]
        where.append(pos)
        chunks.append(b"".join(data[4 * i : 4 * i + 3] for i in pos))
    raw = b"".join(chunks)
    return Image.frombytes("RGB", (max(1, len(raw) // 3), 1), raw or b"\0\0\0"), where


def quantise(images: Sequence[Image.Image], colors: int) -> tuple[list[Grid], dict[str, str]]:
    """One shared palette for every frame (so no state gets its own colours), as token grids
    ranked by luminance like portrait_to_pack (p00 darkest)."""
    strip, where = _opaque_strip(images)
    quant = strip.quantize(
        colors=colors, method=Image.Quantize.MEDIANCUT, kmeans=4, dither=Image.Dither.NONE
    )
    raw = quant.getpalette() or []
    indices = list(quant.getdata())
    used = sorted(
        set(indices), key=lambda i: p2p.luma((raw[3 * i], raw[3 * i + 1], raw[3 * i + 2]))
    )
    token = {i: f"p{rank:02d}" for rank, i in enumerate(used)}
    palette = {token[i]: rgb_to_hex((raw[3 * i], raw[3 * i + 1], raw[3 * i + 2])) for i in used}
    grids: list[Grid] = []
    cursor = 0
    for pos in where:
        grid: Grid = [["." for _ in range(NATIVE)] for _ in range(NATIVE)]
        for p in pos:
            grid[p // NATIVE][p % NATIVE] = token[indices[cursor]]
            cursor += 1
        grids.append(grid)
    return grids, palette


def band_for(state: str, f: int) -> str:
    if state in p2p.STATE_BAND:
        return p2p.STATE_BAND[state][f % 4]
    key = "idle_variant" if state.startswith(IDLE_VARIANT_PREFIX) else state
    return EXTRA_BAND[key][f % 4]


def frame_colors(base: dict[str, str], state: str, f: int) -> dict[str, str]:
    if state == "paused":
        colors = {t: p2p._ramp(c, 1.0, 0) for t, c in base.items()}
    elif state == "offline":
        colors = {t: p2p._ramp(c, 0.55, 0) for t, c in base.items()}
    else:
        colors = dict(base)
    h, a_core, a_edge = p2p.BAND_TONES[band_for(state, f)]
    colors.update(
        {
            "k": p2p.OUTLINE,
            "L": p2p.RIM,
            "i": p2p.OUTLINE,
            "w": p2p.PAPER,
            "q": p2p.PAPER_LINE,
            "y": p2p.BAND_TONES["bright"][1],
            "H": h,
            "A": a_core,
            "a": a_edge,
            "o": p2p.DOT,
        }
    )
    return colors


def _union_grid(grids: Sequence[Grid]) -> Grid:
    out: Grid = [["." for _ in range(NATIVE)] for _ in range(NATIVE)]
    for grid in grids:
        for y, row in enumerate(grid):
            for x, t in enumerate(row):
                if t != ".":
                    out[y][x] = "x"
    return out


def find_light(rest: Grid, light: tuple[int, int] | None = None) -> Box:
    """Status brooch box (native px) on the resting pose's chest, portrait_to_pack's size."""
    ys = [y for y, row in enumerate(rest) if any(t != "." for t in row)]
    xs = [x for row in rest for x, t in enumerate(row) if t != "."]
    if not ys:
        raise ValueError("resting frame is empty")
    top, bottom = min(ys), max(ys)
    lw, lh = 10, 8
    if light is None:
        cx = (min(xs) + max(xs)) / 2
        light = (iround(cx + 0.08 * (max(xs) - min(xs))), iround(top + 0.42 * (bottom - top)))
    return p2p._fit_light(rest, light[0] - lw // 2, light[1] - lh // 2, lw, lh, BOTTOM)


def _box_mean(grid: Grid, box: Box, colors: dict[str, str]) -> RGB | None:
    """Mean colour under an inclusive native box, or None if any pixel there is empty."""
    x0, y0, x1, y1 = box
    total = [0, 0, 0]
    count = 0
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            t = grid[y][x]
            if t == "." or t not in colors:
                return None
            for c, v in enumerate(hex_to_rgb(colors[t])):
                total[c] += v
            count += 1
    return (total[0] // count, total[1] // count, total[2] // count)


def brooch_fits(grid: Grid, portrait: p2p.Portrait, tolerance: float = 48.0) -> bool:
    """The brooch sits at one fixed anchor, but the body under it moves (a jump, a wing held
    across the chest). It is drawn only when the pixels under it still look like the resting
    pose's (mean colour within `tolerance`), so it never lands on a face or a wing."""
    here = _box_mean(grid, portrait.light, portrait.colors)
    rest = _box_mean(portrait.grid, portrait.light, portrait.colors)
    if here is None or rest is None:
        return False
    return sum((a - b) ** 2 for a, b in zip(here, rest, strict=True)) ** 0.5 <= tolerance


def dress(grid: Grid, portrait: p2p.Portrait, state: str, f: int, props: bool = True) -> Grid:
    """portrait_to_pack's look on one keyed, quantised frame."""
    grid = [row[:] for row in grid]
    p2p._open(grid, 3)
    p2p._clean(grid, [])
    if brooch_fits(grid, portrait):
        p2p._brooch(grid, portrait, dot=state == "offline")
    if not props:
        pass
    elif state == "asking":
        p2p._bubble(grid, portrait, "?", (0, 0, -1, -1)[f % 4])
    elif state == "needs_attention":
        p2p._bubble(grid, portrait, "!", (0, -1, 0, -1)[f % 4])
    elif state == "working":
        p2p._bubble(grid, portrait, None, 0, dots=(1, 2, 3, 0)[f % 4])
    elif state == "proposal_ready":
        p2p._card(grid, portrait, (0, 0, -1, -1)[f % 4])
    elif state in ("done", CELEBRATE):
        p2p._sparkles(grid, portrait, f % 4)
    p2p._outline(grid, RING)
    add_rim(grid, "L")
    return grid


# --- the pack -----------------------------------------------------------------------------


@dataclass
class ClipCharacter:
    """A garage.avatars.pack.Character whose frames were drawn from video clips."""

    name: str
    artist: str
    anchors: Anchors
    palette: dict[str, str]
    frames: dict[str, list[Image.Image]]

    def draw_frame(self, state: str, frame: int) -> Image.Image:
        return self.frames[state][frame]


@dataclass(frozen=True)
class Options:
    frames: int = 12
    fps: int = 6
    colors: int = 40
    key: RGB | None = None  # None = read off the sprite base's border
    light: tuple[int, int] | None = None  # brooch centre in native px; None = on the chest
    props: bool = True  # bubbles, card and sparkles like the standard packs
    fill: float | None = None  # character height / cell height, 0.80-0.90; None = fit


def build(
    clips: dict[str, list[Image.Image]],
    base: Image.Image,
    out_dir: Path,
    opts: Options,
    name: str,
    artist: str,
    category: str | None = None,
) -> dict[str, object]:
    """`clips` maps every state (rows per `pack_rows`) to its frames in order."""
    if not MIN_FRAMES <= opts.frames <= MAX_FRAMES:
        raise ValueError(f"frames must be {MIN_FRAMES}..{MAX_FRAMES}")
    if not MIN_ANIMATED_FPS <= opts.fps <= MAX_ANIMATED_FPS:
        raise ValueError(f"fps must be {MIN_ANIMATED_FPS}..{MAX_ANIMATED_FPS}")
    if opts.fill is not None:
        check_fill(opts.fill)
    rows = pack_rows(list(clips))
    key = opts.key or detect_key(base)

    picked: dict[str, list[int]] = {}
    keyed: dict[str, list[Image.Image]] = {}
    for state in rows:
        frames = clips[state]
        end = loop_end([_signature(im) for im in frames])
        picked[state] = pick_frames(len(frames), opts.frames, end)
        keyed[state] = [key_out(frames[i], key) for i in picked[state]]

    boxes = [b for state in rows for im in keyed[state] if (b := opaque_box(im)) is not None]
    rest = opaque_box(keyed[rows[0]][0])
    if rest is None:
        raise ValueError(f"no character in the first {rows[0]} frame")
    tallest_h = max(b[3] - b[1] for b in boxes)
    box = shared_box(boxes, (rest[0] + rest[2]) / 2)
    placement = place(box, opts.fill, tallest_h)

    small = [_enhance(fit_frame(im, placement)) for state in rows for im in keyed[state]]
    grids, base_colors = quantise(small, opts.colors)
    by_state = {
        state: grids[r * opts.frames : (r + 1) * opts.frames] for r, state in enumerate(rows)
    }

    rest_grid = [row[:] for row in by_state[rows[0]][0]]
    p2p._open(rest_grid, 3)
    p2p._clean(rest_grid, [])
    light = find_light(rest_grid, opts.light)
    origin = p2p._prop_origin(_union_grid(grids), MARGIN)
    portrait = p2p.Portrait(rest_grid, base_colors, NATIVE, [], 0, 0, light, origin)

    frames_out: dict[str, list[Image.Image]] = {}
    palette: dict[str, str] = {}
    fills: list[float] = []  # the character alone (no bubbles, card or sparkles)
    for state in rows:
        frames_out[state] = []
        for f, grid in enumerate(by_state[state]):
            fills.append(grid_fill(dress(grid, portrait, state, f, props=False)))
            dressed = dress(grid, portrait, state, f, opts.props)
            colors = frame_colors(base_colors, state, f)
            palette.update({c: c for c in colors.values()})
            frames_out[state].append(render_grid(dressed, colors, FRAME))

    x0, y0, x1, y1 = light
    anchors: Anchors = {
        "status_light": {"x": x0, "y": y0, "w": x1 - x0 + 1, "h": y1 - y0 + 1},
        "chat_button": {"x": FRAME // 2, "y": p2p.BASELINE + 3},
        "baseline": p2p.BASELINE,
    }
    character = ClipCharacter(name, artist, anchors, palette, frames_out)
    result = render_pack(
        character, out_dir, frames=opts.frames, fps=opts.fps, extra_states=rows[len(STATES) :]
    )
    sheet = out_dir / "sheet.png"
    if sheet.stat().st_size > MAX_SHEET_BYTES:
        _shrink_sheet(sheet)
    if category:
        manifest_path = out_dir / "manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        manifest["category"] = category
        manifest_path.write_text(yaml.safe_dump(manifest, sort_keys=False))
    return {
        "out_dir": str(out_dir),
        "rows": rows,
        "frames": opts.frames,
        "fps": opts.fps,
        "key": rgb_to_hex(key),
        "picked": picked,
        "crop_box": list(placement.box),
        "scale": round(placement.scale, 4),
        "fill": opts.fill,
        "fill_limit": round(max_fill(box, tallest_h), 4),
        "fill_rest_min": round(min(fills[: opts.frames]), 4),
        "fill_rest_max": round(max(fills[: opts.frames]), 4),
        "fill_min": round(min(fills), 4),
        "fill_max": round(max(fills), 4),
        "palette_size": result.palette_size,
        "sheet_bytes": sheet.stat().st_size,
        "errors": validate_pack(out_dir),
    }


def _shrink_sheet(sheet: Path) -> None:
    """Re-save as an indexed PNG (binary alpha, <= 255 colours, so nothing changes on read)."""
    with Image.open(sheet) as source:
        image = source.convert("RGBA")
    colours = sorted({(r, g, b) for r, g, b, a in image.getdata() if a == 255})
    index = {c: i + 1 for i, c in enumerate(colours)}
    flat = [0, 0, 0] + [v for c in colours for v in c]
    data = bytes(0 if a == 0 else index[(r, g, b)] for r, g, b, a in image.getdata())
    indexed = Image.frombytes("P", image.size, data)
    indexed.putpalette(flat)
    indexed.save(sheet, transparency=0, optimize=True)


# --- review images ------------------------------------------------------------------------


def plain_label(state: str) -> str:
    return state.replace("_", " ")


def _sheet_frames(pack_dir: Path) -> tuple[list[str], list[list[Image.Image]]]:
    manifest = yaml.safe_load((pack_dir / "manifest.yaml").read_text())
    rows: list[str] = manifest["grid"]["rows"]
    cols: int = manifest["grid"]["columns"]
    with Image.open(pack_dir / "sheet.png") as source:
        sheet = source.convert("RGBA")
    cells = [
        [sheet.crop((c * FRAME, r * FRAME, (c + 1) * FRAME, (r + 1) * FRAME)) for c in range(cols)]
        for r in range(len(rows))
    ]
    return rows, cells


def write_overview(pack_dir: Path, path: Path, title: str) -> Path:
    """One row per state showing every frame at 1x, plain state names on the left, the light
    app background on the left half and the dark one on the right."""
    rows, cells = _sheet_frames(pack_dir)
    cols = len(cells[0])
    pad, label_w, gap, head = 12, 150, 4, 28
    half = cols * FRAME + (cols - 1) * gap
    w = pad + label_w + half + pad + half + pad
    h = head + pad + len(rows) * (FRAME + gap) - gap + pad
    img = Image.new("RGBA", (w, h), LIGHT_BG)
    dark_x = pad + label_w + half + pad
    img.paste(DARK_BG, (dark_x - pad // 2, 0, w, h))
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=14)
    draw.text((pad, 8), title, fill="#2B1B14", font=font)
    for r, state in enumerate(rows):
        y = head + pad + r * (FRAME + gap)
        draw.text((pad, y + FRAME // 2 - 8), plain_label(state), fill="#2B1B14", font=font)
        for c, cell in enumerate(cells[r]):
            img.alpha_composite(cell, (pad + label_w + c * (FRAME + gap), y))
            img.alpha_composite(cell, (dark_x + c * (FRAME + gap), y))
    path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(path)
    return path


def write_sequence_gif(pack_dir: Path, path: Path, fps: int, loops: int = 2) -> Path:
    """Every state in row order, each looped `loops` times, 2x on the light background, with
    the plain state name under the character."""
    rows, cells = _sheet_frames(pack_dir)
    font = ImageFont.load_default(size=14)
    frames: list[Image.Image] = []
    for r, state in enumerate(rows):
        for _ in range(loops):
            for cell in cells[r]:
                canvas = Image.new("RGBA", (2 * FRAME, 2 * FRAME + 24), LIGHT_BG)
                canvas.alpha_composite(
                    cell.resize((2 * FRAME, 2 * FRAME), Image.Resampling.NEAREST)
                )
                ImageDraw.Draw(canvas).text(
                    (8, 2 * FRAME + 4), plain_label(state), fill="#2B1B14", font=font
                )
                frames.append(canvas.convert("RGB"))
    path.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        path, save_all=True, append_images=frames[1:], duration=round(1000 / fps), loop=0
    )
    return path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Turn per-state video frames into a More motion orb pack in code"
    )
    parser.add_argument("frames_dir", type=Path, metavar="FRAMES_DIR", help="<state>/*.png")
    parser.add_argument("base", type=Path, metavar="SPRITE_BASE")
    parser.add_argument("out_dir", type=Path, metavar="OUT_DIR")
    parser.add_argument("--name", required=True)
    parser.add_argument("--artist", default="OASIS")
    parser.add_argument("--category")
    parser.add_argument("--frames", type=int, default=12)
    parser.add_argument("--fps", type=int, default=6)
    parser.add_argument("--colors", type=int, default=40)
    parser.add_argument("--key", help="key colour as #RRGGBB (default: read off the base)")
    parser.add_argument("--light", help="status brooch centre in frame px: x,y")
    parser.add_argument("--no-props", action="store_true", help="skip bubbles, card, sparkles")
    parser.add_argument(
        "--fill", type=float, help="character height / cell height, 0.80-0.90 (default: fit)"
    )
    parser.add_argument("--overview", type=Path, help="write the contact sheet here")
    parser.add_argument("--title", help="contact sheet title (default: --name)")
    parser.add_argument("--sequence-gif", type=Path, help="write all states in one GIF here")
    parser.add_argument("--preview-dir", type=Path, help="copy <state>.gif previews here")
    args = parser.parse_args()
    light = p2p.parse_pairs(args.light)
    opts = Options(
        frames=args.frames,
        fps=args.fps,
        colors=args.colors,
        key=hex_to_rgb(args.key) if args.key else None,
        light=(iround(light[0][0]), iround(light[0][1])) if light else None,
        props=not args.no_props,
        fill=args.fill,
    )
    clips = {
        state: [Image.open(p).convert("RGB") for p in paths]
        for state, paths in load_clips(args.frames_dir).items()
    }
    with Image.open(args.base) as source:
        base = source.convert("RGB")
    report = build(clips, base, args.out_dir, opts, args.name, args.artist, args.category)
    if args.overview:
        report["overview"] = str(
            write_overview(args.out_dir, args.overview, args.title or args.name)
        )
    if args.sequence_gif:
        report["sequence_gif"] = str(write_sequence_gif(args.out_dir, args.sequence_gif, opts.fps))
    if args.preview_dir:
        args.preview_dir.mkdir(parents=True, exist_ok=True)
        for state in pack_rows(list(clips)):
            (args.preview_dir / f"{state}.gif").write_bytes(
                (args.out_dir / f"{state}.gif").read_bytes()
            )
    print(json.dumps(report))
    raise SystemExit(bool(report["errors"]))


if __name__ == "__main__":
    main()
