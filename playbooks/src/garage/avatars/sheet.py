"""Labelled candidate sheets, with the same layout as the six-image reference."""

from collections.abc import Sequence
from pathlib import Path

from PIL import Image, ImageDraw

from .grid import DARK_BG, LIGHT_BG

CELL, PAD, LABEL, COLUMNS = 512, 24, 40, 3


def contact_sheet(
    images: Sequence[Image.Image | str | Path], out_path: str | Path, dark: bool
) -> Path:
    """Composite candidates in input order, labelled from 1, preserving aspect ratio."""
    if not images:
        raise ValueError("contact sheet needs at least one image")
    rows = (len(images) + COLUMNS - 1) // COLUMNS
    canvas = Image.new(
        "RGBA",
        (COLUMNS * CELL + (COLUMNS + 1) * PAD, rows * (CELL + LABEL) + (rows + 1) * PAD),
        DARK_BG if dark else LIGHT_BG,
    )
    draw = ImageDraw.Draw(canvas)
    for index, source in enumerate(images):
        if isinstance(source, Image.Image):
            image = source.convert("RGBA")
        else:
            with Image.open(source) as opened:
                image = opened.convert("RGBA")
        image.thumbnail((CELL, CELL), Image.Resampling.LANCZOS)
        # Upscale the fixture/candidate just as the reference does, without distortion.
        scale = min(CELL / image.width, CELL / image.height)
        image = image.resize(
            (round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS
        )
        x = PAD + index % COLUMNS * (CELL + PAD)
        y = PAD + index // COLUMNS * (CELL + LABEL + PAD)
        draw.text((x, y + 8), str(index + 1), fill="#E6E6E6" if dark else "#282828", font_size=28)
        canvas.alpha_composite(
            image, (x + (CELL - image.width) // 2, y + LABEL + (CELL - image.height) // 2)
        )
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(out_path)
    return out_path
