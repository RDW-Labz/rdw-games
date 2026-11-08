"""Pure WCAG 2.1 relative luminance and contrast ratio math. No dependencies
-- not even PyYAML -- so this module can be read straight across into
agent-core's own kept-in-step mirror (`docs/t23/contract.md` §3) without
dragging this package along.
"""

from __future__ import annotations

import re

RGB = tuple[int, int, int]

_HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}")


def srgb_channel(value: int) -> float:
    """One 0-255 sRGB channel to its linear-light value (WCAG 2.1)."""
    c = value / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb: RGB) -> float:
    """WCAG 2.1 relative luminance of an (r, g, b) triple, each 0-255."""
    r, g, b = rgb
    return 0.2126 * srgb_channel(r) + 0.7152 * srgb_channel(g) + 0.0722 * srgb_channel(b)


def contrast_ratio(fg: RGB, bg: RGB) -> float:
    """WCAG 2.1 contrast ratio between two already-parsed RGB triples:
    `(lighter relative luminance + 0.05) / (darker relative luminance + 0.05)`.
    """
    l1 = relative_luminance(fg) + 0.05
    l2 = relative_luminance(bg) + 0.05
    lighter, darker = (l1, l2) if l1 >= l2 else (l2, l1)
    return lighter / darker


def hex_rgb(value: object) -> RGB | None:
    """Parse a `"#RRGGBB"` string into an (r, g, b) triple; `None` if `value`
    is not a string or not exactly that 6-hex-digit shape (an 8-hex
    `"#RRGGBBAA"` value, e.g. `scrim`, does not parse here -- no contrast
    pair in `docs/t23/contract.md` §2 ever checks one)."""
    if not isinstance(value, str) or _HEX_COLOR_RE.fullmatch(value) is None:
        return None
    return int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16)


def contrast_ratio_hex(fg_hex: object, bg_hex: object) -> float | None:
    """`contrast_ratio` over two `"#RRGGBB"` strings; `None` if either does
    not parse as one."""
    fg, bg = hex_rgb(fg_hex), hex_rgb(bg_hex)
    if fg is None or bg is None:
        return None
    return contrast_ratio(fg, bg)
