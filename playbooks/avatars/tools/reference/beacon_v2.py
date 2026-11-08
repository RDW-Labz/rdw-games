"""OASIS Beacon pack v2 (revision 4) -- the candidate-4 paper-and-brass lantern coworker.

Revision 4 (depth pass):
  - One light source from the top left: hand-placed shading makes the upper-
    left of the body, cap, handle, arms and feet lighter and the lower-right
    darker; the paper right under the cap and right under the band gets a
    1-2 px contact shadow.
  - Inner paper glow: the paper is lit from inside, brightest in the centre
    just below the face/band and fading to the ribs and edges (ribs stay
    visible). Paper tones come from one 8-step ramp (plus a matching rib ramp)
    and the glow strength is keyed on the frame's band tone (GLOW): calm
    "dim" is dimmer, needs-you "white" brightest, paused uses a grey-toned
    ramp, offline an almost unlit one. Level boundaries use a narrow 2x2
    ordered (checker) dither; every pixel is still one flat palette tone.
  - Brass shine: 1-2 px specular ("Y") on the upper-left of the cap, handle
    and each foot, and a deeper brass shade ("d") on the lower-right.
  - Thicker outline: the outer silhouette gets a 2 native px dark outline
    (enclosed gaps such as the handle opening and inner lines stay 1 px; the
    soles become the second outline row so the baseline anchor is unchanged),
    and the light rim is now 1 native px outside it, so both survive the
    128 -> 64 nearest downscale in preview-64-dark.png.
  - No glow halo or ground shadow outside the character (the T17 engine draws
    those, decision #79). New self-check: sheet.png alpha is only 0 or 255.

Revision 3 (Beacon fix round):
  - Curved handle: the square block handle is now a rounded brass arch rising
    from both sides of the top cap, open in the middle (background shows
    through), with the same dark outline and light rim; done keeps its hop.
  - Bigger face: the CRT screen is about 1.5x wider and taller on the native
    64 grid (still centred above the band, not touching it) and the soft eyes
    and mouth are scaled to match, so the face reads at 64 px.
  - White needs-you band: new "white" band tone; asking and needs_attention
    use white, white, white, bright (the blink never drops below bright), so
    no calm or active frame is as light as any needs-you frame.
  - 64 px check: preview-64-dark.png shows frame 0 of idle, asking and paused
    downscaled to 64x64 (nearest) next to the same frames at 128 px.

What changed from beacon_v1.py:
  - The character is now the lantern Braden picked (Higgsfield candidate 4),
    redrawn as original hand-placed pixel art: a round-bellied paper lantern
    body with vertical paper ribs and a warm inner glow, a brass top cap with
    an arched handle, a dark CRT-like screen face with soft pixel eyes,
    a bright amber status band around the waist, small brass arms and feet,
    a bold dark outline and a thin light rim so it reads on dark backgrounds.
  - Same grid/palette approach as v1 (character-coded native grid, palette
    lookup, nearest-neighbour upscale), drawn on a 64x64 native grid and
    scaled 2x to the fixed 128x128 frame (decision #75).

Fixed pack grid (decision #75): 128x128 frames, transparent background,
sheet 512x1024 = 8 rows (one per state, fixed order) x 4 frames, 6 fps loop.
The feet, body and waist band never move between frames so the engine can
anchor on them; only arms, props, the handle and the face animate.

Status looks (decision #74), shown on the amber waist band:
  - calm:     idle, done, offline -> dim (offline also shows a small dark dot)
  - active:   working -> soft pulse; proposal_ready -> single steady glow
  - needs you: asking, needs_attention -> white glow with a blink to bright;
               paused -> grey, still
The band's pixel region is identical in shape and position in every frame
(it is drawn last and is fully opaque), so the T17 engine can later draw the
looks itself at the status_light anchor.

Run from the oasis repo root with Python 3.12 + Pillow (no network, no other
packages). Writes into coordination/references/orb-sketches/beacon-v2/:
sheet.png, manifest.yaml, <state>.gif x8, preview-light.png, preview-dark.png,
preview-64-dark.png.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent
PACK_DIR = OUT_DIR / "beacon-v2"

# ---------------------------------------------------------------------------
# fixed pack grid (decision #75)
# ---------------------------------------------------------------------------

STATES = [
    "idle",
    "working",
    "asking",
    "proposal_ready",
    "done",
    "needs_attention",
    "paused",
    "offline",
]
COLUMNS = 4
FPS = 6
FRAME_MS = round(1000 / FPS)  # 167 ms; GIF stores centiseconds, so ~160-170 ms

N = 64  # native grid
SCALE = 2
FRAME = N * SCALE  # 128
SHEET_W, SHEET_H = FRAME * COLUMNS, FRAME * len(STATES)  # 512 x 1024
CX = 32

# ---------------------------------------------------------------------------
# grid helpers (same style as beacon_v1.py)
# ---------------------------------------------------------------------------

Grid = list[list[str]]


def new_grid() -> Grid:
    return [["." for _ in range(N)] for _ in range(N)]


def set_px(grid: Grid, x: int, y: int, ch: str) -> None:
    if 0 <= y < N and 0 <= x < N:
        grid[y][x] = ch


def hline(grid: Grid, x0: int, x1: int, y: int, ch: str) -> None:
    for x in range(x0, x1 + 1):
        set_px(grid, x, y, ch)


def mirror_x(x: int) -> int:
    return 2 * CX - x


def hline_sym(grid: Grid, x0: int, x1: int, y: int, ch: str) -> None:
    """Draw a left-side span and its mirror on the right."""
    hline(grid, x0, x1, y, ch)
    hline(grid, mirror_x(x1), mirror_x(x0), y, ch)


def iround(v: float) -> int:
    return int(math.floor(v + 0.5))


def line_points(p0: tuple[int, int], p1: tuple[int, int]) -> list[tuple[int, int]]:
    (x0, y0), (x1, y1) = p0, p1
    dx, dy = x1 - x0, y1 - y0
    n = max(abs(dx), abs(dy), 1)
    return [(iround(x0 + dx * i / n), iround(y0 + dy * i / n)) for i in range(n + 1)]


def disc_points(cx: int, cy: int, r2: int) -> set[tuple[int, int]]:
    r = int(math.isqrt(r2)) + 1
    return {(x, y) for y in range(cy - r, cy + r + 1) for x in range(cx - r, cx + r + 1)
            if (x - cx) ** 2 + (y - cy) ** 2 <= r2}


def stamp_disc(grid: Grid, cx: int, cy: int, r2: int, ch: str) -> None:
    for x, y in disc_points(cx, cy, r2):
        set_px(grid, x, y, ch)


def paint_runs(grid: Grid, y: int, x1: int, stops: list[tuple[int, str]]) -> None:
    """Hand-placed shading runs: each (x_start, ch) paints up to the next stop (last one to x1)."""
    for i, (xs, ch) in enumerate(stops):
        xe = stops[i + 1][0] - 1 if i + 1 < len(stops) else x1
        hline(grid, xs, xe, y, ch)


def dither_level(c: float, x: int, y: int) -> int:
    """Quantise a continuous tone level; only the middle of each step uses a 2x2 checker."""
    base = math.floor(c)
    frac = c - base
    if frac >= 0.62 or (frac > 0.38 and (x + y) % 2 == 0):
        base += 1
    return max(0, min(len(PAPER_CH) - 1, base))


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


def hex_to_rgba(h: str) -> tuple[int, int, int, int]:
    return (*hex_to_rgb(h), 255)


def rgb_to_hex(c: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*c)


# ---------------------------------------------------------------------------
# palette
# ---------------------------------------------------------------------------

BASE = {
    "k": "#2B1B14",  # bold outline (dark brown)
    "Y": "#FFF6D0",  # brass specular (1-2 px, upper-left)
    "B": "#F7D071",  # brass highlight
    "b": "#D19A3A",  # brass base
    "n": "#93622A",  # brass shade
    "d": "#6E4519",  # brass deep shade (lower-right)
    "q": "#F2C28A",  # proposal card text lines
    "r": "#E0873A",  # tool handle
    "s": "#211714",  # screen background
    "g": "#5A463A",  # screen glint / dim mouth
    "e": "#FFCF4A",  # eyes, mouth, spark
    "t": "#B9C0C8",  # tool steel
    "c": "#FFFBF2",  # proposal card
}
# offline: lantern unlit -- brass dimmed, screen dark (paper uses the "off" glow ramp)
OFFLINE = {
    "Y": "#C9AC6E",
    "B": "#B39352",
    "b": "#94702F",
    "n": "#664620",
    "d": "#4E3418",
    "s": "#110C0A",
    "g": "#2A201B",
}
RIM = "#FFEFC9"  # light rim, 1 native px outside the outline
DOT = "#140E0C"  # offline dark dot on the band


def shade_hex(h: str, mul: float, desat: float) -> str:
    r, g, b = hex_to_rgb(h)
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    return rgb_to_hex(tuple(max(0, min(255, iround((luma + (c - luma) * (1 - desat)) * mul)))
                            for c in (r, g, b)))


# paper glow: one 8-step ramp from glow core (0) to deepest shade (7), plus the
# matching rib tone at each step; grey (paused) and off (offline) are derived.
PAPER_CH = "01234567"
RIB_CH = "IJKLMOPV"
PAPER_WARM = ["#FFFCF0", "#FFF1D2", "#FDE0B0", "#F7CB90", "#ECB273", "#DC975A", "#C47D45", "#A46436"]
RIB_WARM = ["#F2A452", "#EA9444", "#E0873A", "#D27832", "#C36A2C", "#B05D27", "#984F22", "#7E421D"]
RAMPS = {
    "warm": (PAPER_WARM, RIB_WARM),
    "grey": ([shade_hex(c, 0.92, 0.8) for c in PAPER_WARM], [shade_hex(c, 0.92, 0.8) for c in RIB_WARM]),
    "off": ([shade_hex(c, 0.6, 0.25) for c in PAPER_WARM], [shade_hex(c, 0.6, 0.25) for c in RIB_WARM]),
}

# status band tones: (H glint row, A core row, a edge row)
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
    "working": ["dim", "low", "mid", "low"],  # soft pulse
    "asking": ["white", "white", "white", "bright"],  # white + blink to bright
    "proposal_ready": ["mid"] * 4,  # single steady glow
    "done": ["dim"] * 4,
    "needs_attention": ["white", "white", "white", "bright"],  # white + blink to bright
    "paused": ["grey"] * 4,  # grey, still
    "offline": ["off"] * 4,  # dim + dark dot
}
# inner glow keyed on the band tone: (ramp, level offset, glow gain); lower offset = brighter core
GLOW = {
    "white": ("warm", 0.0, 1.0),  # needs you: brightest
    "bright": ("warm", 0.45, 1.0),
    "mid": ("warm", 0.9, 1.0),
    "low": ("warm", 1.3, 0.95),
    "dim": ("warm", 1.7, 0.9),  # calm: dimmer
    "grey": ("grey", 1.5, 0.9),  # paused: grey-toned
    "off": ("off", 2.6, 0.4),  # offline: almost unlit
}

# ---------------------------------------------------------------------------
# character layout (native 64x64 grid)
# ---------------------------------------------------------------------------

BODY_Y0 = 17
BODY_HW = [12, 14, 15, 16, 17, 17, 18, 18, 19, 19, 19, 20, 20, 20, 20, 21, 21,
           21, 21, 21, 21, 21, 21, 21, 21, 20, 20, 19, 18, 17, 16, 14, 12, 9]  # y17..50
BODY_Y1 = BODY_Y0 + len(BODY_HW) - 1
BODY_MID = (BODY_Y0 + BODY_Y1) / 2
BODY_HALF = (BODY_Y1 - BODY_Y0) / 2
GLOW_CY = 42  # glow centre: just below the face and band
GLOW_RY = 22.0
GLOW_STEPS = 3.4  # ramp steps from glow core to the paper edge
RIB_K = (-0.7, -0.36, 0.0, 0.36, 0.7)
# light from the top left, as a 3D direction for the round handle tube
LIGHT_3D = tuple(v / math.sqrt(3.44) for v in (-1.0, -1.0, 1.2))

BAND_X0, BAND_X1, BAND_Y0, BAND_Y1 = 10, 54, 34, 40
# extra ramp steps (darker) on paper rows touching the cap, band and base
CONTACT = {BODY_Y0: 3.0, BODY_Y0 + 1: 1.5, BAND_Y1 + 1: 2.5, BAND_Y1 + 2: 1.0, BODY_Y1: 2.0}
FEET_BOTTOM = 58  # sole row; the outline turns it dark and adds one row below
LEG_GAP_Y = 53  # below the base plate the gap between the legs keeps a 1 px outline

STATUS_LIGHT = {
    "x": BAND_X0 * SCALE,
    "y": BAND_Y0 * SCALE,
    "w": (BAND_X1 - BAND_X0 + 1) * SCALE,
    "h": (BAND_Y1 - BAND_Y0 + 1) * SCALE,
}
BASELINE = (FEET_BOTTOM + 2) * SCALE - 1  # bottom row of the outline under the feet
CHAT_BUTTON = {"x": CX * SCALE, "y": BASELINE + 3}


def draw_body(grid: Grid, key: str) -> None:
    """Paper lit from inside (glow keyed on the band tone) and shaded from the top left."""
    _, offset, gain = GLOW[key]
    for i, hw in enumerate(BODY_HW):
        y = BODY_Y0 + i
        ribs = {CX + iround(k * hw) for k in RIB_K}
        for x in range(CX - hw, CX + hw + 1):
            nx = (x - CX) / (hw + 0.5)
            glow = GLOW_STEPS * min(1.0, math.hypot(nx, (y - GLOW_CY) / GLOW_RY))
            s = (nx + (y - BODY_MID) / BODY_HALF) / math.sqrt(2)  # -1 upper-left .. +1 lower-right
            light = 1.6 * max(0.0, s - 0.3) - 1.4 * max(0.0, -s - 0.45)
            c = offset + gain * glow + light + CONTACT.get(y, 0.0)
            idx = min(len(PAPER_CH) - 1, iround(c)) if y in CONTACT else dither_level(c, x, y)
            ramp = RIB_CH if x in ribs and abs(x - CX) < hw else PAPER_CH
            set_px(grid, x, y, ramp[idx])


def draw_base_and_feet(grid: Grid) -> None:
    paint_runs(grid, 51, CX + 8, [(CX - 8, "b"), (28, "n"), (37, "d")])
    paint_runs(grid, 52, CX + 6, [(CX - 6, "B"), (28, "b"), (35, "n"), (38, "d")])
    for y in (53, 54):
        paint_runs(grid, y, 27, [(24, "B"), (25, "b"), (27, "n")])
        paint_runs(grid, y, 40, [(37, "B"), (38, "b"), (39, "n"), (40, "d")])
    # feet: specular "Y" on each upper-left, deep shade toward the lower-right
    paint_runs(grid, 55, 28, [(22, "B"), (23, "Y"), (24, "B"), (26, "b"), (28, "n")])
    paint_runs(grid, 55, 42, [(36, "B"), (37, "Y"), (38, "B"), (39, "b"), (41, "n")])
    paint_runs(grid, 56, 29, [(21, "B"), (23, "b"), (28, "n")])
    paint_runs(grid, 56, 43, [(35, "B"), (36, "b"), (41, "n"), (43, "d")])
    paint_runs(grid, 57, 29, [(20, "b"), (27, "n"), (29, "d")])
    paint_runs(grid, 57, 44, [(35, "b"), (40, "n"), (43, "d")])
    hline_sym(grid, 20, 29, FEET_BOTTOM, "n")  # sole; becomes the inner outline row


def draw_cap(grid: Grid) -> None:
    paint_runs(grid, 12, CX + 5, [(CX - 5, "B"), (31, "b"), (35, "n"), (37, "d")])
    paint_runs(grid, 13, CX + 8, [(CX - 8, "B"), (30, "b"), (36, "n"), (40, "d")])
    paint_runs(grid, 14, CX + 11, [(CX - 11, "B"), (28, "b"), (37, "n"), (41, "d")])
    paint_runs(grid, 15, CX + 13, [(CX - 13, "B"), (26, "b"), (36, "n"), (42, "d")])
    lighter = {"d": "n", "n": "b", "b": "B", "B": "b"}  # studs: one step lighter (B inverts)
    for dx in (-9, -4, 4, 9):
        set_px(grid, CX + dx, 15, lighter[grid[15][CX + dx]])
    paint_runs(grid, 16, CX + 13, [(CX - 13, "b"), (27, "n"), (41, "d")])
    for x in (26, 27):
        set_px(grid, x, 13, "Y")  # specular on the upper-left of the dome


def draw_handle(grid: Grid, lift: int) -> None:
    """Rounded brass arch: a 3px round tube whose upper half is a semicircle and
    whose legs drop onto both sides of the cap, lit from the top left (tube
    normals dotted with LIGHT_3D) with a 2 px specular on the upper-left.
    The middle is left empty so the background shows through."""
    top = 3 - lift
    cy = top + 8  # arch centre; the semicircle's top row is `top`
    lx, ly, lz = LIGHT_3D
    for y in range(top, 13):
        for x in range(CX - 8, CX + 9):
            dx = x - CX
            if y <= cy:
                d = math.hypot(dx, y - cy)
                if not 5.5 < d <= 8.5:
                    continue
                ux, uy = dx / d, (y - cy) / d
            else:
                d = abs(dx)
                if d < 6:
                    continue
                ux, uy = (1.0 if dx > 0 else -1.0), 0.0
            r = max(-1.0, min(1.0, (d - 7.0) / 1.5))  # -1 inner edge .. +1 outer edge
            nx, ny = ux * r * 0.8, uy * r * 0.8
            nz = math.sqrt(1.0 - nx * nx - ny * ny)
            lit = nx * lx + ny * ly + nz * lz - 0.12 * dx / 8
            ch = "B" if lit > 0.72 else "b" if lit > 0.45 else "n" if lit > 0.2 else "d"
            set_px(grid, x, y, ch)
    for x, y in ((CX - 5, cy - 5), (CX - 4, cy - 6)):
        set_px(grid, x, y, "Y")


def draw_screen(grid: Grid) -> None:
    x0, x1, y0, y1 = CX - 14, CX + 14, 18, 33  # ends one row above the band outline
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if (x, y) in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
                continue  # rounded outer corners: paper shows through
            if x in (x0, x1) or y in (y0, y1):
                ch = "k"
            elif y == y0 + 1:
                ch = "B"
            elif y == y1 - 1:
                ch = "d" if x >= x1 - 5 else "n"
            elif x == x0 + 1:
                ch = "B"
            elif x == x1 - 1:
                ch = "n"
            else:
                ch = "s"
            set_px(grid, x, y, ch)
    for x, y in ((x0 + 2, y0 + 2), (x1 - 2, y0 + 2), (x0 + 2, y1 - 2), (x1 - 2, y1 - 2)):
        set_px(grid, x, y, "b")
    for x, y in ((x0 + 3, y0 + 3), (x0 + 4, y0 + 3), (x0 + 3, y0 + 4)):
        set_px(grid, x, y, "g")


def draw_face(grid: Grid, eyes: str, mouth: str, dx: int = 0, dy: int = 0) -> None:
    def put(points: list[tuple[int, int]], ch: str) -> None:
        for x, y in points:
            set_px(grid, x + dx, y + dy, ch)

    def both(points: list[tuple[int, int]]) -> list[tuple[int, int]]:
        return points + [(mirror_x(x), y) for x, y in points]

    if eyes == "happy":
        put(both([(24, 25), (25, 24), (26, 23), (27, 23), (28, 24), (29, 25)]), "e")
    elif eyes == "open":
        put(both([(26, 22), (25, 23), (26, 23), (27, 23),
                  (25, 24), (26, 24), (27, 24), (26, 25)]), "e")  # soft oval
    elif eyes == "closed":
        put(both([(x, 24) for x in range(24, 30)]), "e")
    # "off": no eyes

    if mouth == "smile":
        put([(29, 28)] + [(x, 29) for x in range(30, 35)] + [(35, 28)], "e")
    elif mouth == "small":
        put([(x, 29) for x in range(30, 35)], "e")
    elif mouth == "flat":
        put([(x, 29) for x in range(30, 35)], "g")


def draw_band(grid: Grid, dot: bool) -> None:
    for y in range(BAND_Y0, BAND_Y1 + 1):
        for x in range(BAND_X0, BAND_X1 + 1):
            o = (x - CX) % 6  # dividers at CX +/- 3, 9, 15, 21
            if y in (BAND_Y0, BAND_Y1) or x in (BAND_X0, BAND_X1):
                ch = "k"
            elif y == BAND_Y0 + 1:
                ch = "B"
            elif y == BAND_Y1 - 1:
                ch = "n"
            elif o == 3:
                ch = "b"
            elif y == BAND_Y0 + 2:
                ch = "H" if o in (5, 0, 1) else "a"
            elif y == BAND_Y0 + 3:
                ch = "A"
            else:
                ch = "a"
            set_px(grid, x, y, ch)
    if dot:
        for x, y in ((CX, 36), (CX - 1, 37), (CX, 37), (CX + 1, 37), (CX, 38)):
            set_px(grid, x, y, "o")


# ---------------------------------------------------------------------------
# arms and props (joints in left-side coordinates; mirror=True draws the right arm)
# ---------------------------------------------------------------------------

Joints = list[tuple[int, int]]
IDLE_ARM: Joints = [(10, 31), (7, 37), (7, 43)]


def draw_arm(grid: Grid, joints: Joints, mirror: bool) -> None:
    path: list[tuple[int, int]] = []
    for a, b in zip(joints, joints[1:]):
        path += line_points(a, b)
    if mirror:
        path = [(mirror_x(x), y) for x, y in path]
    hx, hy = path[-1]
    for x, y in path:
        stamp_disc(grid, x, y, 5, "k")
    stamp_disc(grid, hx, hy, 10, "k")
    brass = disc_points(hx, hy, 5)
    for x, y in path:
        brass |= disc_points(x, y, 2)
    for x, y in brass:
        # top-left light: lit where the upper-left neighbour is outside the arm,
        # shaded where the lower-right one is (deep shade on lower-right corners)
        ul = (x - 1, y - 1) not in brass
        lr = (x + 1, y + 1) not in brass
        if ul and not lr:
            ch = "B"
        elif lr and not ul:
            ch = "d" if (x + 1, y) not in brass and (x, y + 1) not in brass else "n"
        else:
            ch = "b"
        set_px(grid, x, y, ch)
    set_px(grid, hx - 1, hy - 1, "B")
    set_px(grid, hx + 1, hy + 1, "n")


def draw_both_arms(grid: Grid, joints: Joints) -> None:
    draw_arm(grid, joints, False)
    draw_arm(grid, joints, True)


def draw_tool(grid: Grid, hand: tuple[int, int], spark: bool) -> None:
    """Small screwdriver held in the right hand (given in left coordinates)."""
    hx, hy = hand
    pts = line_points((hx + 1, hy - 2), (hx + 4, hy - 6))
    tip = pts[-1]
    pts = [(mirror_x(x), y) for x, y in pts]
    for x, y in pts:
        stamp_disc(grid, x, y, 2, "k")
    for i, (x, y) in enumerate(pts):
        set_px(grid, x, y, "r" if i < 2 else "t")
    if spark:
        tx, ty = tip
        for x, y in ((tx + 1, ty - 2), (tx + 2, ty - 1)):
            set_px(grid, mirror_x(x), y, "e")


def draw_card(grid: Grid, bob: int) -> None:
    x0, x1, y0, y1 = 52, 60, 12 + bob, 22 + bob
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            edge = x in (x0, x1) or y in (y0, y1)
            set_px(grid, x, y, "k" if edge else "c")
    hline(grid, 54, 58, y0 + 3, "q")
    hline(grid, 54, 58, y0 + 5, "q")
    hline(grid, 54, 56, y0 + 7, "q")


def draw_pose(grid: Grid, state: str, f: int) -> None:
    if state == "idle":
        s = (0, 0, 1, 1)[f]
        draw_both_arms(grid, [(10, 31), (7, 37), (7 + s, 43)])
    elif state == "working":
        draw_arm(grid, IDLE_ARM, False)
        ox, oy = ((0, 0), (1, 1), (0, 0), (-1, -1))[f]
        hand = (8 + ox, 20 + oy)
        draw_tool(grid, hand, spark=(f == 1))
        draw_arm(grid, [(10, 31), (5, 27), hand], True)
    elif state == "asking":
        s = (0, 0, 1, 1)[f]
        draw_arm(grid, [(10, 31), (5, 25), (6 + s, 17)], False)
        draw_arm(grid, IDLE_ARM, True)
    elif state == "proposal_ready":
        bob = (0, 0, -1, -1)[f]
        draw_arm(grid, IDLE_ARM, False)
        draw_card(grid, bob)
        draw_arm(grid, [(mirror_x(54), 31), (mirror_x(59), 28), (mirror_x(57), 24 + bob)], True)
    elif state == "done":
        half: Joints = [(10, 31), (5, 31), (4, 26)]
        up: Joints = [(10, 31), (5, 26), (6, 19)]
        draw_both_arms(grid, (IDLE_ARM, half, up, half)[f])
    elif state == "needs_attention":
        j = (0, -1, 0, -1)[f]
        draw_both_arms(grid, [(10, 31), (5, 25), (6, 17 + j)])
    elif state in ("paused", "offline"):
        draw_both_arms(grid, IDLE_ARM)
    else:
        raise ValueError(state)


FACE = {
    "idle": ("happy", "smile"),
    "working": ("open", "small"),
    "asking": ("open", "small"),
    "proposal_ready": ("happy", "smile"),
    "done": ("happy", "smile"),
    "needs_attention": ("open", "small"),
    "paused": ("closed", "flat"),
    "offline": ("off", "none"),
}


def add_outline(grid: Grid) -> None:
    """Bold dark outline: 1 native px (8-connected) around every filled pixel,
    plus a second px (4-connected) on the outer silhouette only. Enclosed gaps
    (the handle opening) and the leg gap keep 1 px; the grid edge and the rows
    below the outline under the feet get no second px (baseline unchanged),
    and the soles turn dark instead so the bottom is 2 px as well."""
    src = [row[:] for row in grid]
    for y in range(N):
        for x in range(N):
            if src[y][x] != ".":
                continue
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < N and 0 <= ny < N and src[ny][nx] not in (".", "k"):
                        grid[y][x] = "k"

    exterior: set[tuple[int, int]] = set()
    stack = [(x, y) for y in range(N) for x in range(N) if x in (0, N - 1) or y in (0, N - 1)]
    while stack:
        x, y = stack.pop()
        if not (0 <= x < N and 0 <= y < N) or (x, y) in exterior or grid[y][x] != ".":
            continue
        exterior.add((x, y))
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    second = [
        (x, y) for x, y in exterior
        if 1 <= x <= N - 2 and 1 <= y <= FEET_BOTTOM + 1
        and not (y >= LEG_GAP_Y and abs(x - CX) <= 3)
        and any(grid[y + dy][x + dx] == "k" for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
    ]
    for x, y in second:
        grid[y][x] = "k"

    for x in range(N):
        if grid[FEET_BOTTOM][x] not in (".", "k") and grid[FEET_BOTTOM + 1][x] == "k":
            grid[FEET_BOTTOM][x] = "k"


def add_rim(grid: Grid) -> None:
    """Light rim: 1 native px (8-connected) outside the outline, so it survives a 64 px downscale."""
    src = [row[:] for row in grid]
    for y in range(N):
        for x in range(N):
            if src[y][x] != ".":
                continue
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < N and 0 <= ny < N and src[ny][nx] != ".":
                        grid[y][x] = "L"


def build_frame_grid(state: str, f: int) -> Grid:
    grid = new_grid()
    hop = (0, 1, 1, 0)[f] if state == "done" else 0
    draw_body(grid, STATE_BAND[state][f])
    draw_base_and_feet(grid)
    draw_cap(grid)
    draw_handle(grid, lift=hop)
    draw_screen(grid)
    eyes, mouth = FACE[state]
    draw_face(grid, eyes, mouth, dx=1 if state == "working" else 0, dy=-hop)
    draw_pose(grid, state, f)
    draw_band(grid, dot=(state == "offline"))  # last: band region fixed in every frame
    add_outline(grid)
    add_rim(grid)
    return grid


# ---------------------------------------------------------------------------
# image building
# ---------------------------------------------------------------------------

def frame_colors(state: str, f: int) -> dict[str, str]:
    colors = dict(BASE)
    if state == "offline":
        colors.update(OFFLINE)
    key = STATE_BAND[state][f]
    paper, rib = RAMPS[GLOW[key][0]]
    colors.update(zip(PAPER_CH, paper))
    colors.update(zip(RIB_CH, rib))
    h, a_core, a_edge = BAND_TONES[key]
    colors.update({"H": h, "A": a_core, "a": a_edge, "o": DOT, "L": RIM})
    return colors


def render_frame(state: str, f: int) -> Image.Image:
    grid = build_frame_grid(state, f)
    colors = frame_colors(state, f)
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch != ".":
                assert ch in colors, f"char {ch!r} missing from palette"
                px[x, y] = hex_to_rgba(colors[ch])
    return img.resize((FRAME, FRAME), Image.Resampling.NEAREST)


def rgba_pixels(img: Image.Image) -> list[tuple[int, int, int, int]]:
    b = img.convert("RGBA").tobytes()
    return [(b[i], b[i + 1], b[i + 2], b[i + 3]) for i in range(0, len(b), 4)]


def save_gif(frames: list[Image.Image], path: Path) -> None:
    pixel_lists = [rgba_pixels(fr) for fr in frames]
    colors: set[tuple[int, int, int]] = set()
    for pixels in pixel_lists:
        for r, g, b, a in pixels:
            assert a in (0, 255), "frames must be binary alpha for GIF"
            if a == 255:
                colors.add((r, g, b))
    key = (255, 0, 255)
    assert key not in colors
    palette = [key] + sorted(colors)
    assert len(palette) <= 256
    idx = {c: i for i, c in enumerate(palette)}
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
        duration=[FRAME_MS] * len(p_frames),
        loop=0,
        disposal=2,
        transparency=0,
        optimize=False,
    )


def build_preview(frames: dict[str, list[Image.Image]], bg_hex: str, fg_hex: str) -> Image.Image:
    pad, label_w, gap = 12, 128, 6
    w = pad + label_w + COLUMNS * FRAME + (COLUMNS - 1) * gap + pad
    h = pad + len(STATES) * FRAME + (len(STATES) - 1) * gap + pad
    img = Image.new("RGBA", (w, h), hex_to_rgba(bg_hex))
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    for r, state in enumerate(STATES):
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
            draw.text((x, y + size + label_gap), f"{state} {size}px", fill=hex_to_rgba(fg_hex), font=font)
        y += size + label_gap + label_h + gap
    return img


def write_manifest(path: Path, palette_hex: list[str]) -> None:
    sl = STATUS_LIGHT
    lines = [
        "name: Beacon",
        "artist: OASIS (Higgsfield candidate 4 style)",
        "grid:",
        f"  frame: {FRAME}",
        f"  columns: {COLUMNS}",
        f"  rows: [{', '.join(STATES)}]",
        f"  fps: {FPS}",
        "palette:",
        *[f'  - "{c}"' for c in palette_hex],
        "anchors:",
        f"  status_light: {{x: {sl['x']}, y: {sl['y']}, w: {sl['w']}, h: {sl['h']}}}",
        f"  chat_button: {{x: {CHAT_BUTTON['x']}, y: {CHAT_BUTTON['y']}}}",
        f"  baseline: {BASELINE}",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# self-checks
# ---------------------------------------------------------------------------

def check_frame(fr: Image.Image, state: str, f: int) -> None:
    assert fr.size == (FRAME, FRAME), f"{state}[{f}] is {fr.size}"
    px = fr.load()
    corners = [(0, 0), (FRAME - 1, 0), (0, FRAME - 1), (FRAME - 1, FRAME - 1)]
    assert any(px[x, y][3] == 0 for x, y in corners), f"{state}[{f}] has no transparent corner"
    sl = STATUS_LIGHT
    assert 0 <= sl["x"] and 0 <= sl["y"] and sl["x"] + sl["w"] <= FRAME and sl["y"] + sl["h"] <= FRAME
    for y in range(sl["y"], sl["y"] + sl["h"]):
        for x in range(sl["x"], sl["x"] + sl["w"]):
            assert px[x, y][3] == 255, f"{state}[{f}] status band not solid at {(x, y)}"
    rim = hex_to_rgba(RIM)
    lowest = max(y for y in range(FRAME) for x in range(FRAME) if px[x, y][3] != 0 and px[x, y] != rim)
    assert lowest == BASELINE, f"{state}[{f}] baseline {lowest} != {BASELINE}"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    PACK_DIR.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    frames: dict[str, list[Image.Image]] = {}
    sheet = Image.new("RGBA", (SHEET_W, SHEET_H), (0, 0, 0, 0))
    for r, state in enumerate(STATES):
        frames[state] = []
        for f in range(COLUMNS):
            fr = render_frame(state, f)
            check_frame(fr, state, f)
            frames[state].append(fr)
            sheet.alpha_composite(fr, (f * FRAME, r * FRAME))

    assert sheet.size == (512, 1024), sheet.size
    for r, state in enumerate(STATES):
        for f in range(COLUMNS):
            crop = sheet.crop((f * FRAME, r * FRAME, (f + 1) * FRAME, (r + 1) * FRAME))
            assert crop.size == (128, 128)
            assert crop.tobytes() == frames[state][f].tobytes(), f"sheet cell {state}[{f}] mismatch"

    sheet_path = PACK_DIR / "sheet.png"
    sheet.save(sheet_path)
    with Image.open(sheet_path) as saved:
        alphas = set(saved.convert("RGBA").getchannel("A").tobytes())
    assert alphas <= {0, 255}, f"sheet.png has partial alpha {sorted(alphas - {0, 255})[:8]}"
    written.append(str(sheet_path))

    palette_hex = sorted({rgb_to_hex((r, g, b)) for r, g, b, a in rgba_pixels(sheet) if a == 255})
    manifest_path = PACK_DIR / "manifest.yaml"
    write_manifest(manifest_path, palette_hex)
    written.append(str(manifest_path))

    for state in STATES:
        gif_path = PACK_DIR / f"{state}.gif"
        save_gif(frames[state], gif_path)
        written.append(str(gif_path))

    for name, bg, fg in (("preview-light.png", "#F4F1EA", "#2B1B14"), ("preview-dark.png", "#1C1E24", "#F4F1EA")):
        p = PACK_DIR / name
        build_preview(frames, bg, fg).save(p)
        written.append(str(p))

    p = PACK_DIR / "preview-64-dark.png"
    build_preview_64(frames, "#1C1E24", "#F4F1EA").save(p)
    written.append(str(p))

    print(json.dumps({
        "pack": "Beacon",
        "out_dir": str(PACK_DIR),
        "sheet": [SHEET_W, SHEET_H],
        "frame": FRAME,
        "rows": STATES,
        "columns": COLUMNS,
        "fps": FPS,
        "palette_colors": len(palette_hex),
        "status_light": STATUS_LIGHT,
        "chat_button": CHAT_BUTTON,
        "baseline": BASELINE,
        "files": len(written),
        "checks": "ok",
    }))


if __name__ == "__main__":
    main()
