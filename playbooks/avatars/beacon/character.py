"""Beacon's original paper-and-brass shapes, ported from the revision 4 reference."""

from __future__ import annotations

import math

from garage.avatars.grid import COLS, FRAME, STATES
from garage.avatars.pixel import (
    Anchors,
    Grid,
    Image,
    Palette,
    add_outline,
    add_rim,
    disc_points,
    dither_level,
    hline,
    hline_sym,
    iround,
    line_points,
    mirror_x,
    new_grid,
    paint_runs,
    render_grid,
    set_px,
    shade_hex,
    stamp_disc,
)

N = 64
SCALE = 2
CX = 32
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


# paper glow: one 8-step ramp from glow core (0) to deepest shade (7), plus the
# matching rib tone at each step; grey (paused) and off (offline) are derived.
PAPER_CH = "01234567"
RIB_CH = "IJKLMOPV"
PAPER_WARM = [
    "#FFFCF0",
    "#FFF1D2",
    "#FDE0B0",
    "#F7CB90",
    "#ECB273",
    "#DC975A",
    "#C47D45",
    "#A46436",
]
RIB_WARM = ["#F2A452", "#EA9444", "#E0873A", "#D27832", "#C36A2C", "#B05D27", "#984F22", "#7E421D"]
RAMPS = {
    "warm": (PAPER_WARM, RIB_WARM),
    "grey": (
        [shade_hex(c, 0.92, 0.8) for c in PAPER_WARM],
        [shade_hex(c, 0.92, 0.8) for c in RIB_WARM],
    ),
    "off": (
        [shade_hex(c, 0.6, 0.25) for c in PAPER_WARM],
        [shade_hex(c, 0.6, 0.25) for c in RIB_WARM],
    ),
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
BODY_HW = [
    12,
    14,
    15,
    16,
    17,
    17,
    18,
    18,
    19,
    19,
    19,
    20,
    20,
    20,
    20,
    21,
    21,
    21,
    21,
    21,
    21,
    21,
    21,
    21,
    21,
    20,
    20,
    19,
    18,
    17,
    16,
    14,
    12,
    9,
]  # y17..50
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
        put(
            both([(26, 22), (25, 23), (26, 23), (27, 23), (25, 24), (26, 24), (27, 24), (26, 25)]),
            "e",
        )  # soft oval
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
    for a, b in zip(joints, joints[1:], strict=False):
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
    add_outline(grid, feet_bottom=FEET_BOTTOM, gap_y=LEG_GAP_Y, center=CX)
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
    colors.update(zip(PAPER_CH, paper, strict=True))
    colors.update(zip(RIB_CH, rib, strict=True))
    h, a_core, a_edge = BAND_TONES[key]
    colors.update({"H": h, "A": a_core, "a": a_edge, "o": DOT, "L": RIM})
    return colors


class BeaconCharacter:
    name = "Beacon"
    artist = "OASIS (Higgsfield candidate 4 style)"
    anchors: Anchors = {
        "status_light": {"x": 20, "y": 68, "w": 90, "h": 14},
        "chat_button": {"x": 64, "y": 122},
        "baseline": 119,
    }
    palette: Palette = {
        c: c for state in STATES for f in range(COLS) for c in frame_colors(state, f).values()
    }

    def draw_frame(self, state: str, frame: int) -> Image.Image:
        return render_grid(build_frame_grid(state, frame), frame_colors(state, frame), FRAME)


CHARACTER = BeaconCharacter()
