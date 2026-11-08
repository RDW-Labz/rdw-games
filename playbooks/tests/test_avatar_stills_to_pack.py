"""Synthetic r1 portraits only; no real art or generation provenance."""

import json
import random
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
import yaml
from PIL import Image, ImageDraw, PngImagePlugin

from garage.avatars.grid import STATES
from garage.avatars.tools.stills_to_pack import THEMES, THUMB_MAX_BYTES, build
from garage.avatars.validate import validate_pack

DATE = "2026-10-01"


def sources(directory: Path, theme: str) -> None:
    directory.mkdir(parents=True)
    for number in range(1, 13):
        image = Image.new("RGBA", (683, 1024), (number * 16, 48, 90, 220))
        draw = ImageDraw.Draw(image)
        draw.rectangle((270, 200, 412, 600), fill=(200, number * 16, 60, 255))
        # Fine original detail must survive in the 512 px derivative.
        draw.line((300, 700, 300, 900), fill=(255, 255, 255, 255), width=2)
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("fixture", "must not ship")
        image.save(directory / f"{theme}-{number:02d}-1024.png", pnginfo=metadata)


def run(source: Path, dest: Path, theme: str = "arcade") -> dict[str, object]:
    return build(source, dest / "packs", dest / "portraits", dest / "CREDITS.md", DATE, theme=theme)


def snapshot(directory: Path) -> dict[str, bytes]:
    return {
        p.relative_to(directory).as_posix(): p.read_bytes()
        for p in directory.rglob("*")
        if p.is_file()
    }


def test_all_96_ids_categories_cells_and_source_identity(tmp_path: Path) -> None:
    root = tmp_path / "source"
    for theme in THEMES:
        sources(root / theme, theme)
    originals = snapshot(root)
    out = tmp_path / "out"
    out.mkdir()
    credits = out / "CREDITS.md"
    previous = b"fantasy-03 clips - generated 2026-09-29, OASIS-owned output\n"
    credits.write_bytes(previous)
    # Retained motion entries must never be rewritten or removed.
    legacy = out / "packs" / "pets-01"
    legacy.mkdir(parents=True)
    (legacy / "manifest.yaml").write_text("tier: animated\n")
    (legacy / "sheet.png").write_bytes(b"legacy sentinel")
    before_legacy = snapshot(legacy)
    report = build(root, out / "packs", out / "portraits", credits, DATE)
    ids = report["ids"]
    assert isinstance(ids, list) and len(ids) == len(set(ids)) == 96
    expected_bytes = 0
    for theme in THEMES:
        for number in range(1, 13):
            pack_id = f"{theme}-{number:02d}-r1"
            assert pack_id in ids
            pack = out / "packs" / pack_id
            assert {p.name for p in pack.iterdir()} == {"manifest.yaml", "sheet.png"}
            manifest = yaml.safe_load((pack / "manifest.yaml").read_text())
            assert manifest["name"] == f"{theme.title()} {number:02d}"
            assert manifest["category"] == theme.title()
            assert manifest["artist"] == "OASIS"
            assert manifest["tier"] == "standard"
            assert manifest["grid"] == {
                "frame": 128,
                "columns": 4,
                "rows": list(STATES),
                "fps": 6,
            }
            assert validate_pack(pack) == []
            with Image.open(pack / "sheet.png") as sheet:
                assert sheet.size == (512, 1024)
                first = sheet.crop((0, 0, 128, 128)).tobytes()
                for row in range(8):
                    for col in range(4):
                        assert (
                            sheet.crop(
                                (col * 128, row * 128, (col + 1) * 128, (row + 1) * 128)
                            ).tobytes()
                            == first
                        )
                pixels = list(sheet.getdata())
                assert {p[3] for p in pixels} == {0, 255}
                used = {f"#{r:02X}{g:02X}{b:02X}" for r, g, b, a in pixels if a == 255}
                assert used == set(manifest["palette"])
                assert 1 <= len(used) <= 255
                assert "fixture" not in sheet.info
            thumb = out / "portraits" / f"{pack_id}.png"
            assert thumb.stat().st_size <= THUMB_MAX_BYTES
            source = root / theme / f"{theme}-{number:02d}-1024.png"
            with Image.open(source) as original, Image.open(thumb) as portrait:
                assert portrait.size == (512, 512)
                # 683 / 2 rounds to 342, centered on the transparent square.
                expected = original.resize((342, 512), Image.Resampling.LANCZOS)
                assert portrait.crop((85, 0, 427, 512)).tobytes() == expected.tobytes()
                assert portrait.getchannel("A").getbbox() == (85, 0, 427, 512)
                assert "fixture" not in portrait.info
                assert any(0 < a < 255 for a in portrait.getchannel("A").getdata())
            expected_bytes += sum(p.stat().st_size for p in pack.iterdir()) + thumb.stat().st_size
            line = (
                f"- {theme.title()} {number:02d} ({pack_id}) — source: "
                f"{json.dumps(source.as_posix())}; OASIS-owned output; packaging date: {DATE}"
            )
            assert credits.read_text().count(line) == 1
    assert report["asset_bytes"] == expected_bytes
    assert credits.read_bytes().startswith(previous)
    assert credits.read_text().count("packaging date:") == 96
    assert snapshot(legacy) == before_legacy
    assert snapshot(root) == originals


def test_deterministic_build_and_refuses_rerun(tmp_path: Path) -> None:
    source = tmp_path / "source"
    sources(source, "arcade")
    run(source, tmp_path / "a")
    run(source, tmp_path / "b")
    first = snapshot(tmp_path / "a")
    assert first == snapshot(tmp_path / "b")
    with pytest.raises(FileExistsError):
        run(source, tmp_path / "a")
    assert snapshot(tmp_path / "a") == first


@pytest.mark.parametrize("collision", ["pack", "portrait"])
def test_refuses_any_existing_id_before_writes(tmp_path: Path, collision: str) -> None:
    source = tmp_path / "source"
    sources(source, "arcade")
    out = tmp_path / "out"
    path = (
        out / "packs" / "arcade-12-r1"
        if collision == "pack"
        else out / "portraits" / "arcade-12-r1.png"
    )
    path.parent.mkdir(parents=True)
    path.write_bytes(b"preserve me")
    before = snapshot(out)
    with pytest.raises(FileExistsError, match="output already exists"):
        run(source, out)
    assert snapshot(out) == before


@pytest.mark.parametrize("problem", ["missing", "duplicate", "size", "corrupt", "empty"])
def test_refuses_bad_sources_before_writes(tmp_path: Path, problem: str) -> None:
    source = tmp_path / "source"
    sources(source, "arcade")
    last = source / "arcade-12-1024.png"
    if problem == "missing":
        last.rename(source / "unexpected.txt")
    elif problem == "duplicate":
        (source / "duplicate.png").write_bytes(last.read_bytes())
    elif problem == "size":
        Image.new("RGBA", (8, 12)).save(last)
    elif problem == "empty":
        Image.new("RGBA", (683, 1024)).save(last)
    else:
        last.write_bytes(last.read_bytes()[:100])
    with pytest.raises((ValueError, OSError, SyntaxError)):
        run(source, tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_lossless_portrait_over_cap_is_explicit_refusal(tmp_path: Path) -> None:
    source = tmp_path / "source"
    sources(source, "arcade")
    image = Image.frombytes("RGB", (683, 1024), random.Random(78).randbytes(683 * 1024 * 3))
    image.save(source / "arcade-01-1024.png")
    with pytest.raises(ValueError, match=r"arcade-01-r1: lossless portrait.*262144"):
        run(source, tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_cli_requires_date_and_builds_one_theme(tmp_path: Path) -> None:
    source = tmp_path / "source"
    sources(source, "pets")
    command = [
        sys.executable,
        "-m",
        "garage.avatars.tools.stills_to_pack",
        "--source",
        str(source),
        "--theme",
        "pets",
        "--out",
        str(tmp_path / "packs"),
        "--portraits",
        str(tmp_path / "portraits"),
    ]
    refused = subprocess.run(command, capture_output=True, text=True)
    assert refused.returncode != 0 and "--date" in refused.stderr
    result = subprocess.run([*command, "--date", DATE], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["ids"] == [f"pets-{i:02d}-r1" for i in range(1, 13)]
    assert (tmp_path / "packs" / "CREDITS.md").read_text().count("packaging date:") == 12


def test_wheel_declares_packs_and_sibling_portraits() -> None:
    config = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    wheel = config["tool"]["hatch"]["build"]["targets"]["wheel"]
    assert "src/garage" in wheel["packages"]
    assert "src/garage/avatars/packs/**" in wheel["artifacts"]
    assert "src/garage/avatars/portraits/**" in wheel["artifacts"]
