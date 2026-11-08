import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from garage.avatars.grid import STATES
from garage.avatars.pack import Character, render_pack
from garage.avatars.pixel import Image, rgba_pixels
from garage.avatars.validate import validate_pack

ROOT = Path(__file__).resolve().parents[1]


def beacon() -> Character:
    spec = importlib.util.spec_from_file_location(
        "beacon_character", ROOT / "avatars/beacon/character.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.BeaconCharacter()


def test_beacon_rebuild_matches_shipped(tmp_path: Path) -> None:
    character = beacon()
    result = render_pack(character, tmp_path)
    assert validate_pack(tmp_path) == []
    shipped = yaml.safe_load((ROOT / "avatars/beacon/manifest.yaml").read_text())
    rebuilt = yaml.safe_load((tmp_path / "manifest.yaml").read_text())
    assert rebuilt["anchors"] == shipped["anchors"]
    assert result.palette_size == len(shipped["palette"]) == 77
    assert len(result.files) == 13 and all(path.is_file() for path in result.files)
    with (
        Image.open(tmp_path / "sheet.png") as image,
        Image.open(ROOT / "avatars/beacon/sheet.png") as reference,
    ):
        differences = sum(
            a != b for a, b in zip(rgba_pixels(image), rgba_pixels(reference), strict=True)
        )
        assert differences / (512 * 1024) <= 0.02, (
            f"pixel difference: {differences / (512 * 1024):.6%}"
        )
    for state in STATES:
        with Image.open(tmp_path / f"{state}.gif") as gif:
            assert gif.info["loop"] == 0
            total_duration = 0
            for index in range(gif.n_frames):
                gif.seek(index)
                total_duration += gif.info["duration"]
                assert gif.size == (128, 128)
                assert gif.convert("RGBA").getpixel((0, 127))[3] == 0
            assert 630 <= total_duration <= 680
    for name in ("preview-light.png", "preview-dark.png", "preview-64-dark.png"):
        with Image.open(tmp_path / name) as image:
            assert image.width > 128 and image.height > 128


@pytest.mark.parametrize(
    "script",
    ["prompts", "contact_sheet", "build_pack", "validate_pack", "score_pack", "portrait_to_pack"],
)
def test_cli_help(script: str) -> None:
    result = subprocess.run(
        [sys.executable, str(ROOT / "avatars/tools" / f"{script}.py"), "--help"],
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    assert "usage:" in result.stdout


def test_invalid_frame_rejected(tmp_path: Path) -> None:
    class WrongSize:
        name = "fixture"
        artist = "fixture"
        anchors = beacon().anchors
        palette = {"x": "#FF00FF"}

        def draw_frame(self, state: str, frame: int) -> Image.Image:
            return Image.new("RGBA", (64, 64))

    with pytest.raises(ValueError, match=r"frame size: idle\[0\] must be 128x128"):
        render_pack(WrongSize(), tmp_path)


def test_non_beacon_character_and_magenta_gif(tmp_path: Path) -> None:
    class SquareCharacter:
        name = "Square fixture"
        artist = "Test fixture"
        anchors = beacon().anchors
        palette = {"fill": "#FF00FF"}

        def draw_frame(self, state: str, frame: int) -> Image.Image:
            image = Image.new("RGBA", (128, 128))
            image.paste((255, 0, 255, 255), (20, 20, 110, 120))
            return image

    result = render_pack(SquareCharacter(), tmp_path)
    assert result.palette_size == 1
    assert validate_pack(tmp_path) == []
    with Image.open(tmp_path / "idle.gif") as gif:
        image = gif.convert("RGBA")
        assert image.getpixel((20, 20)) == (255, 0, 255, 255)
        assert image.getpixel((0, 0))[3] == 0


@pytest.mark.parametrize(
    "mode,message",
    [
        ("alpha", r"frame alpha: idle\[0\] must be binary"),
        ("colour", "frame colour: pixel missing from character palette"),
    ],
)
def test_invalid_frame_pixels(tmp_path: Path, mode: str, message: str) -> None:
    class InvalidCharacter:
        name = "Invalid fixture"
        artist = "Test fixture"
        anchors = beacon().anchors
        palette = {"fill": "#000000"}

        def draw_frame(self, state: str, frame: int) -> Image.Image:
            image = Image.new("RGBA", (128, 128))
            image.putpixel((20, 20), (255, 0, 255, 128 if mode == "alpha" else 255))
            return image

    with pytest.raises(ValueError, match=message):
        render_pack(InvalidCharacter(), tmp_path)


class _SquareCharacter:
    """A state/frame-agnostic fixture character, valid for any row/column count."""

    name = "Square fixture"
    artist = "Test fixture"
    anchors = beacon().anchors
    palette = {"fill": "#FF00FF"}

    def draw_frame(self, state: str, frame: int) -> Image.Image:
        image = Image.new("RGBA", (128, 128))
        image.paste((255, 0, 255, 255), (20, 20, 110, 120))
        return image


def test_render_pack_animated_tier(tmp_path: Path) -> None:
    """A synthetic animated pack, built and validated with no image files committed."""
    result = render_pack(
        _SquareCharacter(),
        tmp_path,
        frames=6,
        fps=8,
        extra_states=("idle_variant_1", "celebrate"),
    )
    assert validate_pack(tmp_path) == []
    manifest = yaml.safe_load((tmp_path / "manifest.yaml").read_text())
    assert manifest["tier"] == "animated"
    assert manifest["frames"] == 6
    assert manifest["fps"] == 8
    assert manifest["grid"] == {
        "frame": 128,
        "columns": 6,
        "rows": [*STATES, "idle_variant_1", "celebrate"],
        "fps": 8,
    }
    with Image.open(tmp_path / "sheet.png") as sheet:
        assert sheet.size == (128 * 6, 128 * 10)
    for name in ("idle_variant_1.gif", "celebrate.gif"):
        assert (tmp_path / name).is_file()
    assert len(result.files) == 2 + 10 + 3
    assert all(path.is_file() for path in result.files)


def test_render_pack_default_output_unchanged(tmp_path: Path) -> None:
    """Called with no animated-tier keywords, render_pack still emits a plain pack."""
    result = render_pack(_SquareCharacter(), tmp_path)
    manifest = yaml.safe_load((tmp_path / "manifest.yaml").read_text())
    assert "tier" not in manifest
    assert "frames" not in manifest
    assert "fps" not in manifest
    assert manifest["grid"] == {
        "frame": 128,
        "columns": 4,
        "rows": list(STATES),
        "fps": 6,
    }
    assert len(result.files) == 13


@pytest.mark.parametrize(
    "kwargs,message",
    [
        ({"frames": 3}, r"frames must be 4\.\.12"),
        ({"frames": 13}, r"frames must be 4\.\.12"),
        ({"fps": 5}, r"fps must be 6\.\.12"),
        ({"fps": 13}, r"fps must be 6\.\.12"),
    ],
)
def test_render_pack_rejects_out_of_range_animated_values(
    tmp_path: Path, kwargs: dict[str, int], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        render_pack(_SquareCharacter(), tmp_path, **kwargs)
