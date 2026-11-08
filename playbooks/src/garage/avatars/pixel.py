"""Character-neutral pixel grids, palettes and hand-placed depth helpers."""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import TypedDict

from PIL import Image as Image

Grid = list[list[str]]
Palette = Mapping[str, str]
GlowKey = tuple[str, float, float]


class Point(TypedDict):
    x: int
    y: int


class Rect(Point):
    w: int
    h: int


class Anchors(TypedDict):
    status_light: Rect
    chat_button: Point
    baseline: int


def new_grid(size: int = 64) -> Grid:
    return [["." for _ in range(size)] for _ in range(size)]


def set_px(grid: Grid, x: int, y: int, ch: str) -> None:
    if 0 <= y < len(grid) and 0 <= x < len(grid[y]):
        grid[y][x] = ch


def hline(grid: Grid, x0: int, x1: int, y: int, ch: str) -> None:
    for x in range(x0, x1 + 1):
        set_px(grid, x, y, ch)


def mirror_x(x: int, center: int = 32) -> int:
    return 2 * center - x


def hline_sym(grid: Grid, x0: int, x1: int, y: int, ch: str, center: int = 32) -> None:
    """Draw a left-side span and its mirror on the right."""
    hline(grid, x0, x1, y, ch)
    hline(grid, mirror_x(x1, center), mirror_x(x0, center), y, ch)


def iround(v: float) -> int:
    return int(math.floor(v + 0.5))


def line_points(p0: tuple[int, int], p1: tuple[int, int]) -> list[tuple[int, int]]:
    (x0, y0), (x1, y1) = p0, p1
    dx, dy = x1 - x0, y1 - y0
    n = max(abs(dx), abs(dy), 1)
    return [(iround(x0 + dx * i / n), iround(y0 + dy * i / n)) for i in range(n + 1)]


def disc_points(cx: int, cy: int, r2: int) -> set[tuple[int, int]]:
    r = int(math.isqrt(r2)) + 1
    return {
        (x, y)
        for y in range(cy - r, cy + r + 1)
        for x in range(cx - r, cx + r + 1)
        if (x - cx) ** 2 + (y - cy) ** 2 <= r2
    }


def stamp_disc(grid: Grid, cx: int, cy: int, r2: int, ch: str) -> None:
    for x, y in disc_points(cx, cy, r2):
        set_px(grid, x, y, ch)


def paint_runs(grid: Grid, y: int, x1: int, stops: list[tuple[int, str]]) -> None:
    """Hand-placed shading runs: each (x_start, ch) paints up to the next stop (last one to x1)."""
    for i, (xs, ch) in enumerate(stops):
        xe = stops[i + 1][0] - 1 if i + 1 < len(stops) else x1
        hline(grid, xs, xe, y, ch)


def dither_level(c: float, x: int, y: int, levels: int = 8) -> int:
    """Quantise a continuous tone level; only the middle of each step uses a 2x2 checker."""
    base = math.floor(c)
    frac = c - base
    if frac >= 0.62 or (frac > 0.38 and (x + y) % 2 == 0):
        base += 1
    return max(0, min(levels - 1, base))


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


def hex_to_rgba(h: str) -> tuple[int, int, int, int]:
    return (*hex_to_rgb(h), 255)


def rgb_to_hex(c: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*c)


def shade_hex(h: str, mul: float, desat: float) -> str:
    r, g, b = hex_to_rgb(h)
    luma = 0.299 * r + 0.587 * g + 0.114 * b

    def channel(c: int) -> int:
        return max(0, min(255, iround((luma + (c - luma) * (1 - desat)) * mul)))

    return rgb_to_hex((channel(r), channel(g), channel(b)))


def add_outline(
    grid: Grid, *, feet_bottom: int, gap_y: int, center: int, outline: str = "k"
) -> None:
    """Bold dark outline: 1 native px (8-connected) around every filled pixel,
    plus a second px (4-connected) on the outer silhouette only. Enclosed gaps
    (the handle opening) and the leg gap keep 1 px; the grid edge and the rows
    below the outline under the feet get no second px (baseline unchanged),
    and the soles turn dark instead so the bottom is 2 px as well."""
    N = len(grid)
    src = [row[:] for row in grid]
    for y in range(N):
        for x in range(N):
            if src[y][x] != ".":
                continue
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < N and 0 <= ny < N and src[ny][nx] not in (".", outline):
                        grid[y][x] = outline

    exterior: set[tuple[int, int]] = set()
    stack = [(x, y) for y in range(N) for x in range(N) if x in (0, N - 1) or y in (0, N - 1)]
    while stack:
        x, y = stack.pop()
        if not (0 <= x < N and 0 <= y < N) or (x, y) in exterior or grid[y][x] != ".":
            continue
        exterior.add((x, y))
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    second = [
        (x, y)
        for x, y in exterior
        if 1 <= x <= N - 2
        and 1 <= y <= feet_bottom + 1
        and not (y >= gap_y and abs(x - center) <= 3)
        and any(grid[y + dy][x + dx] == outline for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
    ]
    for x, y in second:
        grid[y][x] = outline

    for x in range(N):
        if grid[feet_bottom][x] not in (".", outline) and grid[feet_bottom + 1][x] == outline:
            grid[feet_bottom][x] = outline


def add_rim(grid: Grid, rim: str = "L") -> None:
    """Light rim: 1 native px outside the outline, surviving a 64 px downscale."""
    N = len(grid)
    src = [row[:] for row in grid]
    for y in range(N):
        for x in range(N):
            if src[y][x] != ".":
                continue
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < N and 0 <= ny < N and src[ny][nx] != ".":
                        grid[y][x] = rim


def rgba_pixels(img: Image.Image) -> list[tuple[int, int, int, int]]:
    b = img.convert("RGBA").tobytes()
    return [(b[i], b[i + 1], b[i + 2], b[i + 3]) for i in range(0, len(b), 4)]


def render_grid(grid: Grid, colors: Palette, size: int = 128) -> Image.Image:
    """Render palette tokens with binary alpha and nearest-neighbour scaling."""
    image = Image.new("RGBA", (len(grid[0]), len(grid)))
    image.putdata(
        [hex_to_rgba(colors[ch]) if ch != "." else (0, 0, 0, 0) for row in grid for ch in row]
    )
    return image.resize((size, size), Image.Resampling.NEAREST)
