"""Package approved r1 stills; no generation, motion synthesis or portrait quantization.

Existing IDs are always refused, including identical reruns. Rebuilding into a fresh
destination with the same sources and packaging date produces identical bytes.
"""

from __future__ import annotations

import argparse
import json
from datetime import date
from io import BytesIO
from pathlib import Path

import yaml
from PIL import Image

from garage.avatars.grid import COLS, FPS, FRAME, STATES
from garage.avatars.validate import validate_pack

THEMES = ("arcade", "space", "desert", "robot", "office", "pets", "fantasy", "hitchhiker")
SOURCE_SIZE = (683, 1024)
THUMB_MAX_BYTES = 262_144


def _png(image: Image.Image) -> bytes:
    output = BytesIO()
    image.info.clear()
    image.save(output, format="PNG", optimize=True, compress_level=9)
    return output.getvalue()


def _canvas(source: Image.Image, size: int) -> Image.Image:
    scale = min(size / source.width, size / source.height)
    resized = source.resize(
        (round(source.width * scale), round(source.height * scale)), Image.Resampling.LANCZOS
    )
    canvas = Image.new("RGBA", (size, size))
    # No alpha mask: preserve the source's partial alpha rather than multiplying it.
    canvas.paste(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def _derivatives(source: Path, pack_id: str, theme: str, number: int) -> tuple[bytes, bytes, bytes]:
    with Image.open(source) as opened:
        if opened.format != "PNG" or opened.size != SOURCE_SIZE or opened.n_frames != 1:
            raise ValueError(f"{pack_id}: source must be a single 683 x 1024 PNG")
        opened.verify()
    with Image.open(source) as opened:
        original = opened.convert("RGBA")
    portrait = _png(_canvas(original, 512))
    if len(portrait) > THUMB_MAX_BYTES:
        raise ValueError(
            f"{pack_id}: lossless portrait is {len(portrait)} bytes; cap is {THUMB_MAX_BYTES}; "
            "Braden's visual decision is required"
        )
    frame = _canvas(original, FRAME)
    alpha = frame.getchannel("A").point([0] * 128 + [255] * 128)
    frame = (
        frame.convert("RGB")
        .quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        .convert("RGBA")
    )
    frame.putalpha(alpha)
    pixels = list(frame.getdata())
    palette = sorted({f"#{r:02X}{g:02X}{b:02X}" for r, g, b, a in pixels if a == 255})
    if not palette:
        raise ValueError(f"{pack_id}: source has no opaque sprite pixels")
    sheet = Image.new("RGBA", (FRAME * COLS, FRAME * len(STATES)))
    for row in range(len(STATES)):
        for col in range(COLS):
            sheet.paste(frame, (col * FRAME, row * FRAME))
    manifest = {
        "name": f"{theme.title()} {number:02d}",
        "artist": "OASIS",
        "tier": "standard",
        "category": theme.title(),
        "grid": {"frame": FRAME, "columns": COLS, "rows": list(STATES), "fps": FPS},
        "palette": palette,
        "anchors": {
            "status_light": {"x": 20, "y": 68, "w": 90, "h": 14},
            "chat_button": {"x": 64, "y": 122},
            "baseline": 119,
        },
    }
    return yaml.safe_dump(manifest, sort_keys=False).encode("utf-8"), _png(sheet), portrait


def build(
    source: Path,
    packs_dir: Path,
    portraits_dir: Path,
    credits: Path,
    packaging_date: str,
    *,
    theme: str | None = None,
) -> dict[str, object]:
    """Build one theme directory, or all eight directories under a source root.

    Validate the complete input inventory and prepare every derivative before writes.
    Append credit blocks without changing existing motion provenance. The caller owns
    the output directories; this offline build tool is not a concurrent import route.
    """
    if date.fromisoformat(packaging_date).isoformat() != packaging_date:
        raise ValueError("packaging date must be YYYY-MM-DD")
    if theme is not None and theme not in THEMES:
        raise ValueError("unknown theme")
    themes = (theme,) if theme else THEMES
    for path in (packs_dir, portraits_dir, credits):
        if any(parent.is_symlink() for parent in (path, *path.parents)):
            raise ValueError("output paths must not contain symlinks")
    old_credits = credits.read_bytes() if credits.exists() else b""
    inventory: list[tuple[Path, str, str, int]] = []
    blocks: list[str] = []
    seen_sources: set[tuple[int, int]] = set()
    for category in themes:
        directory = source if theme else source / category
        expected = [directory / f"{category}-{i:02d}-1024.png" for i in range(1, 13)]
        actual = {p for p in directory.rglob("*") if p.suffix.lower() == ".png"}
        if actual != set(expected):
            raise ValueError(
                f"{category}: expected exactly 12 named source PNGs; missing/extra input"
            )
        marker = f"<!-- t78-stills:{category}:r1 -->"
        if marker.encode() in old_credits:
            raise FileExistsError(f"{category}: credit block already exists")
        lines = [marker, f"### {category.title()} r1 stills", ""]
        for number, path in enumerate(expected, 1):
            pack_id = f"{category}-{number:02d}-r1"
            if any(parent.is_symlink() for parent in (path, *path.parents)) or not path.is_file():
                raise ValueError(f"{pack_id}: source must be a regular PNG file")
            stat = path.stat()
            identity = (stat.st_dev, stat.st_ino)
            if identity in seen_sources:
                raise ValueError(f"{pack_id}: duplicate source file")
            seen_sources.add(identity)
            for output in (packs_dir / pack_id, portraits_dir / f"{pack_id}.png"):
                if output.exists() or output.is_symlink():
                    raise FileExistsError(f"{pack_id}: output already exists")
            inventory.append((path, pack_id, category, number))
            lines.append(
                f"- {category.title()} {number:02d} ({pack_id}) — source: "
                f"{json.dumps(path.as_posix(), ensure_ascii=True)}; OASIS-owned output; "
                f"packaging date: {packaging_date}"
            )
        blocks.append("\n".join(lines) + "\n")
    prepared = [
        (pack_id, _derivatives(path, pack_id, category, number))
        for path, pack_id, category, number in inventory
    ]
    packs_dir.mkdir(parents=True, exist_ok=True)
    portraits_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for pack_id, (manifest, sheet, portrait) in prepared:
        directory = packs_dir / pack_id
        directory.mkdir()
        for path, content in (
            (directory / "manifest.yaml", manifest),
            (directory / "sheet.png", sheet),
            (portraits_dir / f"{pack_id}.png", portrait),
        ):
            with path.open("xb") as stream:
                stream.write(content)
            total += len(content)
        errors = validate_pack(directory)
        if errors:
            raise ValueError(f"{pack_id}: output validation failed: {errors}")
    credits.parent.mkdir(parents=True, exist_ok=True)
    with credits.open("ab") as stream:
        stream.write(("\n\n" if old_credits else "").encode() + "\n".join(blocks).encode())
    return {
        "ids": [pack_id for pack_id, _ in prepared],
        "packaging_date": packaging_date,
        "asset_bytes": total,
        "cost": 0,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--source", type=Path, help="one theme's source directory; needs --theme")
    inputs.add_argument(
        "--source-root", type=Path, help="root containing all eight theme directories"
    )
    parser.add_argument("--theme", choices=THEMES)
    parser.add_argument("--out", "--packs-dir", dest="packs", type=Path, required=True)
    parser.add_argument(
        "--portraits", "--portraits-dir", dest="portraits", type=Path, required=True
    )
    parser.add_argument("--credits", type=Path, help="defaults to <out>/CREDITS.md")
    parser.add_argument("--date", required=True, help="explicit packaging date, YYYY-MM-DD")
    args = parser.parse_args(argv)
    if bool(args.source) != bool(args.theme):
        parser.error("--source and --theme must be supplied together")
    try:
        report = build(
            args.source or args.source_root,
            args.packs,
            args.portraits,
            args.credits or args.packs / "CREDITS.md",
            args.date,
            theme=args.theme,
        )
    except (OSError, ValueError, SyntaxError) as exc:
        parser.exit(1, f"stills_to_pack: {exc}\n")
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
