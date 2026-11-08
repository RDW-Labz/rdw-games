"""Build-time CLI: turn one transparent portrait into a fixed-grid orb pack in plain code.

No image model, no network, no credits. The portrait is cropped, scaled to the 128 px
frame, palette-quantised and given binary alpha with a dark outline and light rim; the
eight states x four frames (decisions #74, #75) are then derived procedurally: a breathing
bob and head tilt (a row warp above the chest), a blink (an eye-box edit, when eye centres
are given), a status brooch at a fixed anchor (Beacon's tone per state), and small props
(bubbles, a card, sparkles). Run with uv run from the repository root.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import yaml
from PIL import Image, ImageEnhance

from garage.avatars.grid import COLS, DARK_BG, FRAME, LIGHT_BG, STATES
from garage.avatars.pack import render_pack
from garage.avatars.pixel import (
    Anchors,
    Grid,
    add_rim,
    hex_to_rgb,
    iround,
    render_grid,
    rgb_to_hex,
    set_px,
)
from garage.avatars.validate import validate_pack

RGB = tuple[int, int, int]
Box = tuple[int, int, int, int]  # x0, y0, x1, y1 inclusive (native grid)
FRAMINGS = ("head-shoulders", "full-body")
BASELINE = 119  # frame row of the outline's bottom edge, as Beacon
OUTLINE = "#231713"
RIM = "#FFF3DC"
PAPER = "#FFFBF2"
PAPER_LINE = "#B6ABA0"
DOT = "#140E0C"
# Status tones and their per-state sequence copied from Beacon (H glint, A core, a edge),
# so every pack keeps the same brightness-means-urgency language.
BAND_TONES = {
    "white": ("#FFFFFF", "#FFF4D6", "#FFD27A"),
    "bright": ("#FFF1B8", "#FFC53D", "#F29A1F"),
    "mid": ("#FFD98A", "#F2AA3C", "#CF7F1E"),
    "low": ("#E9B864", "#CC8E33", "#A66A22"),
    "dim": ("#C4904A", "#A2702E", "#7C5322"),
    "off": ("#6A4C30", "#57402A", "#473424"),
    "grey": ("#B7B9BD", "#8F9297", "#6E7176"),
}
STATE_BAND = {
    "idle": ["dim"] * 4,
    "working": ["dim", "low", "mid", "low"],
    "asking": ["white", "white", "white", "bright"],
    "proposal_ready": ["mid"] * 4,
    "done": ["dim"] * 4,
    "needs_attention": ["white", "white", "white", "bright"],
    "paused": ["grey"] * 4,
    "offline": ["off"] * 4,
}
# One shared warm-grey ramp: paused maps luminance onto it, offline a dimmed luminance,
# so the two quiet states add 10 colours, not two copies of the portrait palette.
GREY_RAMP = [
    "#2E2A28",
    "#433E3B",
    "#58524E",
    "#6D6762",
    "#837C76",
    "#99928B",
    "#AEA8A1",
    "#C3BEB7",
    "#D8D4CE",
    "#EDEAE5",
]
# Procedural motion per state and frame: (bob up px, tilt px at the crown, eyes closed).
# Idle breathes down, down, up, up (a 1 px shoulder rise that eases into the still torso,
# the head riding along); every awake state carries one blink frame, paired against a frame
# with the same bob/tilt so the only pixels a blink changes are inside the eye boxes; paused
# and offline stay fully closed throughout, so there is no blink transition to show.
MOTION: dict[str, list[tuple[int, int, bool]]] = {
    "idle": [(0, 0, False), (0, 0, False), (1, 0, False), (1, 0, True)],
    "working": [(0, -1, False), (0, -1, False), (0, -1, True), (0, -1, False)],
    "asking": [(0, 1, False), (0, 2, False), (0, 3, False), (0, 1, True)],
    "proposal_ready": [(0, 0, False), (0, 0, False), (1, 0, False), (1, 0, True)],
    "done": [(0, 0, False), (1, 0, True), (2, 0, True), (1, 0, False)],
    "needs_attention": [(0, 0, False), (1, 0, False), (0, 0, True), (1, 0, False)],
    "paused": [(0, 0, True)] * 4,
    "offline": [(0, 0, True)] * 4,
}
GLYPHS = {
    "?": [".###.", "#...#", "....#", "..##.", "..#..", ".....", "..#.."],
    "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
}


def luma(c: RGB) -> float:
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def parse_pairs(text: str | None) -> list[tuple[float, float]]:
    if not text:
        return []
    values = [float(v) for v in text.split(",")]
    if len(values) % 2:
        raise ValueError("expected x,y pairs")
    return [(values[i], values[i + 1]) for i in range(0, len(values), 2)]


@dataclass(frozen=True)
class Options:
    framing: str = "head-shoulders"
    native: int = 128  # 128 = one source pixel per frame pixel; 64 = chunky 2x pixels
    colors: int = 36
    bust: float = 0.30  # head-shoulders: fraction of the figure height kept from the top
    eyes: tuple[tuple[float, float], ...] = ()  # eye centres in source pixels
    eye_size: tuple[float, float] = (64.0, 30.0)  # eye box in source pixels
    light: tuple[float, float] | None = None  # brooch centre in source pixels
    neck: float | None = None  # source row where the head stops moving


@dataclass
class Portrait:
    """The quantised base grid plus the native-grid landmarks the frames animate."""

    grid: Grid
    colors: dict[str, str]
    n: int
    eyes: list[Box]
    neck_y: int
    chest_y: int
    light: Box
    prop_origin: tuple[int, int]


def _opaque_bbox(image: Image.Image) -> Box:
    mask = image.getchannel("A").point(lambda a: 255 if a >= 128 else 0)
    box = mask.getbbox()
    if box is None:
        raise ValueError("portrait has no opaque pixels")
    return box


def build_portrait(source: Image.Image, opts: Options) -> Portrait:
    if opts.framing not in FRAMINGS:
        raise ValueError(f"framing must be one of {FRAMINGS}")
    if opts.native not in (64, 128):
        raise ValueError("native must be 64 or 128")
    image = source.convert("RGBA")
    n = opts.native
    k = FRAME // n
    ring = 2 if n == 128 else 1  # outline thickness in native px (2 frame px either way)
    margin = ring + 1  # plus 1 px rim
    bottom = (BASELINE + 1) // k - 1 - ring  # last content row
    box_w, box_h = n - 2 * margin, bottom - margin + 1
    bx0, by0, bx1, by1 = _opaque_bbox(image)
    fig_h = by1 - by0
    if opts.eyes:
        head_x = sum(x for x, _ in opts.eyes) / len(opts.eyes)
    else:
        top_band = image.crop((bx0, by0, bx1, by0 + max(1, fig_h // 8)))
        tx0, _, tx1, _ = _opaque_bbox(top_band) if top_band.getbbox() else (0, 0, bx1 - bx0, 0)
        head_x = bx0 + (tx0 + tx1) / 2
    if opts.framing == "full-body":
        crop_h = float(fig_h)
        crop_w = max(bx1 - bx0, crop_h * box_w / box_h)
        cx = (bx0 + bx1) / 2
    else:
        crop_h = fig_h * opts.bust
        crop_w = crop_h * box_w / box_h
        cx = head_x
    scale = min(box_w / crop_w, box_h / crop_h)
    out_w, out_h = max(1, iround(crop_w * scale)), max(1, iround(crop_h * scale))
    sx0, sy0 = cx - crop_w / 2, float(by0)
    crop = image.crop((iround(sx0), iround(sy0), iround(sx0 + crop_w), iround(sy0 + crop_h)))
    small = crop.convert("RGBa").resize((out_w, out_h), Image.Resampling.LANCZOS).convert("RGBA")
    ox, oy = (n - out_w) // 2, bottom - out_h + 1

    def to_native(x: float, y: float) -> tuple[int, int]:
        return iround(ox + (x - sx0) * scale), iround(oy + (y - sy0) * scale)

    rgb = ImageEnhance.Contrast(ImageEnhance.Color(small.convert("RGB")).enhance(1.2)).enhance(1.08)
    alpha = small.getchannel("A").tobytes()
    opaque = [(x, y) for y in range(out_h) for x in range(out_w) if alpha[y * out_w + x] >= 128]
    if not opaque:
        raise ValueError("portrait vanished at this size")
    rgb_bytes = rgb.tobytes()
    strip = Image.frombytes(
        "RGB",
        (len(opaque), 1),
        b"".join(rgb_bytes[3 * (y * out_w + x) : 3 * (y * out_w + x) + 3] for x, y in opaque),
    )
    quant = strip.quantize(
        colors=opts.colors, method=Image.Quantize.MEDIANCUT, kmeans=4, dither=Image.Dither.NONE
    )
    raw = quant.getpalette() or []
    indices = list(quant.getdata())
    used = sorted(set(indices), key=lambda i: luma((raw[3 * i], raw[3 * i + 1], raw[3 * i + 2])))
    token = {i: f"p{rank:02d}" for rank, i in enumerate(used)}
    colors = {token[i]: rgb_to_hex((raw[3 * i], raw[3 * i + 1], raw[3 * i + 2])) for i in used}
    grid: Grid = [["." for _ in range(n)] for _ in range(n)]
    for (x, y), i in zip(opaque, indices, strict=True):
        set_px(grid, x + ox, y + oy, token[i])
    if opts.framing == "head-shoulders":
        # the bust is cut flat on the last content row: fill it so the outline runs straight
        for x in range(n):
            if grid[bottom - 1][x] != "." and grid[bottom][x] == ".":
                grid[bottom][x] = grid[bottom - 1][x]

    ew, eh = opts.eye_size
    eyes: list[Box] = []
    for ex, ey in opts.eyes:
        x, y = to_native(ex, ey)
        hw, hh = max(1, iround(ew * scale / 2)), max(1, iround(eh * scale / 2))
        eyes.append((x - hw, y - hh, x + hw, y + hh))
    _open(grid, 3 if n == 128 else 2)
    _clean(grid, eyes)

    if opts.neck is not None:
        neck_y = to_native(0, opts.neck)[1]
    elif len(opts.eyes) >= 2:
        (ax, ay), (bx, by) = opts.eyes[0], opts.eyes[1]
        span = abs(bx - ax) + abs(by - ay)
        neck_y = to_native(0, (ay + by) / 2 + 1.9 * span)[1]
    else:
        neck_y = oy + out_h // 3 if opts.framing == "head-shoulders" else oy + out_h // 8
    neck_y = max(margin + 2, min(bottom - 8, neck_y))

    lw, lh = (10, 8) if n == 128 else (5, 4)
    if opts.light is not None:
        lx, ly = to_native(*opts.light)
    else:
        lx, ly = iround(n / 2 + 0.22 * out_w), iround(neck_y + 0.45 * (bottom - neck_y))
    light = _fit_light(grid, lx - lw // 2, ly - lh // 2, lw, lh, bottom)
    chest_y = min(light[1] - 1, neck_y + max(3, (light[1] - neck_y) // 2))
    chest_y = max(chest_y, neck_y + 1)
    return Portrait(grid, colors, n, eyes, neck_y, chest_y, light, _prop_origin(grid, margin))


def _open(grid: Grid, size: int) -> None:
    """Morphological opening of the silhouette: strands thinner than `size` px (a glasses
    chain, loose hairs) would become a dotted outline, so they are dropped."""
    n = len(grid)
    offsets = [(dx, dy) for dy in range(size) for dx in range(size)]
    anchors = {
        (x, y)
        for y in range(n - size + 1)
        for x in range(n - size + 1)
        if all(grid[y + dy][x + dx] != "." for dx, dy in offsets)
    }
    covered = {(x + dx, y + dy) for x, y in anchors for dx, dy in offsets}
    for y in range(n):
        for x in range(n):
            if (x, y) not in covered:
                grid[y][x] = "."


def _clean(grid: Grid, keep: list[Box]) -> None:
    """Drop stray alpha specks and single-pixel colour noise; eye boxes are left alone."""
    n = len(grid)

    def kept(x: int, y: int) -> bool:
        return any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in keep)

    src = [row[:] for row in grid]
    for y in range(n):
        for x in range(n):
            around = [
                src[y + dy][x + dx]
                for dy in (-1, 0, 1)
                for dx in (-1, 0, 1)
                if (dx or dy) and 0 <= x + dx < n and 0 <= y + dy < n
            ]
            filled = [t for t in around if t != "."]
            if src[y][x] != "." and len(filled) <= 1:
                grid[y][x] = "."
            elif src[y][x] == "." and len(filled) >= 7:
                grid[y][x] = Counter(filled).most_common(1)[0][0]
    src = [row[:] for row in grid]
    for y in range(1, n - 1):
        for x in range(1, n - 1):
            t = src[y][x]
            if t == "." or kept(x, y):
                continue
            four = [src[y - 1][x], src[y + 1][x], src[y][x - 1], src[y][x + 1]]
            if t in four or "." in four:
                continue
            best, count = Counter(four).most_common(1)[0]
            if count >= 3:
                grid[y][x] = best


def _fit_light(grid: Grid, x: int, y: int, w: int, h: int, bottom: int) -> Box:
    """Nearest placement to (x, y) where the whole brooch sits on opaque pixels."""
    n = len(grid)

    def solid(px: int, py: int) -> bool:
        return all(
            0 <= px + i < n and 0 <= py + j <= bottom and grid[py + j][px + i] != "."
            for j in range(h)
            for i in range(w)
        )

    for r in range(n):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                if max(abs(dx), abs(dy)) == r and solid(x + dx, y + dy):
                    return (x + dx, y + dy, x + dx + w - 1, y + dy + h - 1)
    raise ValueError("no opaque area large enough for the status light")


def _prop_origin(grid: Grid, margin: int) -> tuple[int, int]:
    """Top corner (right first) with the most empty space for a bubble or card."""
    n = len(grid)
    size = n // 5

    def empty(x0: int) -> int:
        return sum(
            grid[y][x] == "." for y in range(margin, margin + size) for x in range(x0, x0 + size)
        )

    right, left = n - margin - size, margin
    return (right, margin) if empty(right) >= empty(left) else (left, margin)


def _warp(grid: Grid, p: Portrait, bob: int, tilt: int) -> Grid:
    """Head and shoulders lift by `bob` and lean by `tilt` px at the crown; the rows below
    the chest never move, so the status light and the body under it stay fixed."""
    if not bob and not tilt:
        return [row[:] for row in grid]
    n = p.n
    top = next((y for y in range(n) if any(t != "." for t in grid[y])), 0)
    out: Grid = [["." for _ in range(n)] for _ in range(n)]
    for y in range(n):
        if y <= p.neck_y:
            dy = bob
        elif y < p.chest_y:
            dy = iround(bob * (p.chest_y - y) / (p.chest_y - p.neck_y))
        else:
            dy = 0
        sy = y + dy
        lean = tilt * (p.neck_y - sy) / max(1, p.neck_y - top) if sy < p.neck_y else 0.0
        shift = iround(lean)
        for x in range(n):
            sx = x - shift
            if 0 <= sy < n and 0 <= sx < n:
                out[y][x] = grid[sy][sx]
    return out


def _close_eyes(grid: Grid, p: Portrait) -> None:
    for x0, y0, x1, y1 in p.eyes:
        ring = Counter(
            grid[y][x]
            for y in range(y0 - 2, y1 + 3)
            for x in range(x0 - 2, x1 + 3)
            if 0 <= x < p.n and 0 <= y < p.n and not (x0 <= x <= x1 and y0 <= y <= y1)
        )
        lids = [t for t, _ in ring.most_common() if t != "." and t >= "p08"]
        if not lids:
            continue
        lid = lids[0]
        lash = min((t for t in ring if t != "."), default=lid)
        mid = (y0 + y1 + 1) // 2
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if grid[y][x] != ".":
                    grid[y][x] = (
                        lash
                        if y == mid and x0 < x < x1 or y == mid - 1 and (x in (x0, x1))
                        else lid
                    )


def _stamp(grid: Grid, x: int, y: int, rows: list[str], ch: str, scale: int) -> None:
    for j, row in enumerate(rows):
        for i, c in enumerate(row):
            if c == "#":
                for a in range(scale):
                    for b in range(scale):
                        set_px(grid, x + i * scale + a, y + j * scale + b, ch)


def _bubble(grid: Grid, p: Portrait, glyph: str | None, dy: int, dots: int = 0) -> None:
    s = 2 if p.n == 128 else 1
    x0, y0 = p.prop_origin
    w, h = 9 * s, 10 * s
    right = x0 > p.n // 2
    y0 += dy
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            corner = (x - x0 < s or x - x0 >= w - s) and (y - y0 < s or y - y0 >= h - s)
            if not corner:
                set_px(grid, x, y, "w")
    tail_x = x0 + (s if right else w - 3 * s)
    for i in range(2 * s):
        for j in range(2 * s - i):
            set_px(grid, tail_x + (j if right else 2 * s - 1 - j), y0 + h + i, "w")
    if glyph:
        _stamp(grid, x0 + 2 * s, y0 + s + s // 2, GLYPHS[glyph], "i", s)
    for d in range(dots):
        for a in range(s):
            for b in range(s):
                set_px(grid, x0 + (2 + 2 * d) * s + a, y0 + 5 * s + b, "i")


def _card(grid: Grid, p: Portrait, dy: int) -> None:
    s = 2 if p.n == 128 else 1
    x0, y0 = p.prop_origin
    w, h = 8 * s, 10 * s
    y0 += dy
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            set_px(grid, x, y, "w")
    for row, length in ((2, 5), (4, 5), (6, 3)):
        for x in range(x0 + s, x0 + (1 + length) * s):
            for b in range(s):
                set_px(grid, x, y0 + row * s + b, "q")


def _sparkles(grid: Grid, p: Portrait, f: int) -> None:
    """Two twinkling four-point stars by the head: one grows while the other shrinks."""
    s = 2 if p.n == 128 else 1
    x0, y0 = p.prop_origin
    spots = [(x0 + 3 * s, y0 + 8 * s), (x0 + 8 * s, y0 + 3 * s)]
    sizes = ((2, 0), (3, 1), (1, 3), (0, 2))[f]
    for (cx, cy), arm in zip(spots, sizes, strict=True):
        if not arm:
            continue
        for d in range(-arm * s, arm * s + 1):
            for t in range(s):
                set_px(grid, cx + d, cy + t, "y")
                set_px(grid, cx + t, cy + d, "y")


def _brooch(grid: Grid, p: Portrait, dot: bool) -> None:
    x0, y0, x1, y1 = p.light
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            corner = x in (x0, x1) and y in (y0, y1)
            if corner:
                continue  # rounded: the cardigan shows through (still opaque)
            if x in (x0, x1) or y in (y0, y1):
                ch = "k"
            elif y == y0 + 1 and x < x0 + (x1 - x0) // 2 + 1:
                ch = "H"
            elif y == y1 - 1 or x == x1 - 1:
                ch = "a"
            else:
                ch = "A"
            grid[y][x] = ch
    if dot:
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        for x, y in ((cx, cy), (cx + 1, cy), (cx, cy + 1), (cx + 1, cy + 1)):
            grid[y][x] = "o"


def _outline(grid: Grid, ring: int) -> None:
    """Dark outline: 1 px (8-connected) round every filled pixel, plus a second px
    (4-connected) on the outer silhouette when ring == 2; enclosed gaps keep 1 px."""
    n = len(grid)
    src = [row[:] for row in grid]
    for y in range(n):
        for x in range(n):
            if src[y][x] == "." and any(
                0 <= x + dx < n and 0 <= y + dy < n and src[y + dy][x + dx] != "."
                for dy in (-1, 0, 1)
                for dx in (-1, 0, 1)
            ):
                grid[y][x] = "k"
    if ring < 2:
        return
    exterior: set[tuple[int, int]] = set()
    stack = [(x, y) for y in range(n) for x in range(n) if x in (0, n - 1) or y in (0, n - 1)]
    while stack:
        x, y = stack.pop()
        if not (0 <= x < n and 0 <= y < n) or (x, y) in exterior or grid[y][x] != ".":
            continue
        exterior.add((x, y))
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    for x, y in [
        (x, y)
        for x, y in exterior
        if any(
            0 <= x + dx < n and 0 <= y + dy < n and grid[y + dy][x + dx] == "k"
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
        )
    ]:
        grid[y][x] = "k"


def build_grid(p: Portrait, state: str, f: int) -> Grid:
    bob, tilt, closed = MOTION[state][f]
    grid = [row[:] for row in p.grid]
    if closed:
        _close_eyes(grid, p)
    grid = _warp(grid, p, bob, tilt)
    _brooch(grid, p, dot=state == "offline")
    if state == "asking":
        _bubble(grid, p, "?", (0, 0, -1, -1)[f])
    elif state == "needs_attention":
        _bubble(grid, p, "!", (0, -1, 0, -1)[f])
    elif state == "working":
        _bubble(grid, p, None, 0, dots=(1, 2, 3, 0)[f])
    elif state == "proposal_ready":
        _card(grid, p, (0, 0, -1, -1)[f])
    elif state == "done":
        _sparkles(grid, p, f)
    _outline(grid, 2 if p.n == 128 else 1)
    add_rim(grid, "L")
    return grid


def _ramp(hex_colour: str, dim: float, lift: int) -> str:
    level = luma(hex_to_rgb(hex_colour)) * dim / 256 * len(GREY_RAMP)
    return GREY_RAMP[max(0, min(len(GREY_RAMP) - 1, int(level) + lift))]


def state_colors(p: Portrait, state: str, f: int) -> dict[str, str]:
    if state == "paused":
        colors = {t: _ramp(c, 1.0, 0) for t, c in p.colors.items()}
    elif state == "offline":
        colors = {t: _ramp(c, 0.55, 0) for t, c in p.colors.items()}
    else:
        colors = dict(p.colors)
    h, a_core, a_edge = BAND_TONES[STATE_BAND[state][f]]
    colors.update(
        {
            "k": OUTLINE,
            "L": RIM,
            "i": OUTLINE,
            "w": PAPER,
            "q": PAPER_LINE,
            "y": BAND_TONES["bright"][1],
            "H": h,
            "A": a_core,
            "a": a_edge,
            "o": DOT,
        }
    )
    return colors


class PortraitCharacter:
    """A garage.avatars.pack.Character made from one portrait."""

    def __init__(self, portrait: Portrait, name: str, artist: str) -> None:
        self.portrait = portrait
        self.name = name
        self.artist = artist
        x0, y0, x1, y1 = portrait.light
        k = FRAME // portrait.n
        self.anchors: Anchors = {
            "status_light": {
                "x": x0 * k,
                "y": y0 * k,
                "w": (x1 - x0 + 1) * k,
                "h": (y1 - y0 + 1) * k,
            },
            "chat_button": {"x": FRAME // 2, "y": BASELINE + 3},
            "baseline": BASELINE,
        }
        self.palette = {
            c: c for s in STATES for f in range(COLS) for c in state_colors(portrait, s, f).values()
        }

    def draw_frame(self, state: str, frame: int) -> Image.Image:
        p = self.portrait
        return render_grid(build_grid(p, state, frame), state_colors(p, state, frame), FRAME)


def build(
    source: Path | Image.Image,
    out_dir: Path,
    opts: Options,
    name: str,
    artist: str,
    category: str | None = None,
) -> dict[str, object]:
    image = Image.open(source) if isinstance(source, Path) else source
    portrait = build_portrait(image, opts)
    result = render_pack(PortraitCharacter(portrait, name, artist), out_dir)
    if category:
        manifest_path = out_dir / "manifest.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        manifest["category"] = category
        manifest_path.write_text(yaml.safe_dump(manifest, sort_keys=False))
    return {
        "out_dir": str(out_dir),
        "palette_size": result.palette_size,
        "blink": bool(portrait.eyes),
        "status_light": dict(PortraitCharacter(portrait, name, artist).anchors["status_light"]),
        "errors": validate_pack(out_dir),
    }


def write_previews(out_dir: Path) -> list[Path]:
    """Review images: all 32 frames at 4x, and frame 0 of every state at orb size (1x, 2x),
    each on the light and dark app backgrounds. Nearest-neighbour only."""
    with Image.open(out_dir / "sheet.png") as source:
        sheet = source.convert("RGBA")
    paths: list[Path] = []
    big = Image.new("RGBA", (sheet.width * 8 + 8, sheet.height * 4), LIGHT_BG)
    dark = Image.new("RGBA", (sheet.width * 4, sheet.height * 4), DARK_BG)
    zoom = sheet.resize((sheet.width * 4, sheet.height * 4), Image.Resampling.NEAREST)
    big.alpha_composite(zoom)
    dark.alpha_composite(zoom)
    big.alpha_composite(dark, (sheet.width * 4 + 8, 0))
    paths.append(out_dir / "preview-contact-4x.png")
    big.save(paths[-1])
    for scale in (1, 2):
        size, pad = FRAME * scale, 8 * scale
        orb = Image.new("RGBA", (len(STATES) * (size + pad) + pad, 2 * (size + pad) + pad))
        for row, bg in enumerate((LIGHT_BG, DARK_BG)):
            y = pad + row * (size + pad)
            orb.paste(bg, (0, y - pad // 2, orb.width, y + size + pad // 2))
            for i in range(len(STATES)):
                cell = sheet.crop((0, i * FRAME, FRAME, (i + 1) * FRAME))
                cell = cell.resize((size, size), Image.Resampling.NEAREST)
                orb.alpha_composite(cell, (pad + i * (size + pad), y))
        paths.append(out_dir / f"preview-orb-{scale}x.png")
        orb.save(paths[-1])
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Turn one transparent portrait into an orb pack in code (no image model)"
    )
    parser.add_argument("portrait", type=Path, metavar="PORTRAIT")
    parser.add_argument("out_dir", type=Path, metavar="OUT_DIR")
    parser.add_argument("--name", required=True)
    parser.add_argument("--artist", default="OASIS")
    parser.add_argument("--category")
    parser.add_argument("--framing", choices=FRAMINGS, default="head-shoulders")
    parser.add_argument("--native", type=int, choices=(64, 128), default=128)
    parser.add_argument("--colors", type=int, default=36)
    parser.add_argument("--bust", type=float, default=0.30)
    parser.add_argument("--eyes", help="eye centres in source pixels: x1,y1,x2,y2")
    parser.add_argument("--eye-size", default="64,30", help="eye box w,h in source pixels")
    parser.add_argument("--light", help="status brooch centre in source pixels: x,y")
    parser.add_argument("--neck", type=float, help="source row where the head stops moving")
    parser.add_argument("--previews", action="store_true", help="also write review images")
    args = parser.parse_args()
    light = parse_pairs(args.light)
    (ew, eh), *_ = parse_pairs(args.eye_size)
    opts = Options(
        framing=args.framing,
        native=args.native,
        colors=args.colors,
        bust=args.bust,
        eyes=tuple(parse_pairs(args.eyes)),
        eye_size=(ew, eh),
        light=light[0] if light else None,
        neck=args.neck,
    )
    report = build(args.portrait, args.out_dir, opts, args.name, args.artist, args.category)
    if args.previews:
        report["previews"] = [str(path) for path in write_previews(args.out_dir)]
    print(json.dumps(report))
    raise SystemExit(bool(report["errors"]))


if __name__ == "__main__":
    main()
