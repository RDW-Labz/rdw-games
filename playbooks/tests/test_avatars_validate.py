import shutil
from pathlib import Path

import pytest
import yaml

from garage.avatars.grid import COLS, STATES
from garage.avatars.pixel import Image
from garage.avatars.validate import validate_pack

BEACON = Path(__file__).resolve().parents[1] / "avatars/beacon"


@pytest.fixture
def pack(tmp_path: Path) -> Path:
    for name in ("manifest.yaml", "sheet.png"):
        shutil.copyfile(BEACON / name, tmp_path / name)
    return tmp_path


def resized_sheet(columns: int, rows: int) -> Image.Image:
    """A sheet of the given size: Beacon's own frames where they overlap the
    original 4x8 grid, fully transparent (still-valid) pixels elsewhere."""
    with Image.open(BEACON / "sheet.png") as source:
        beacon = source.convert("RGBA")
    canvas = Image.new("RGBA", (128 * columns, 128 * rows))
    for row in range(min(rows, len(STATES))):
        for col in range(min(columns, COLS)):
            frame = beacon.crop((col * 128, row * 128, (col + 1) * 128, (row + 1) * 128))
            canvas.paste(frame, (col * 128, row * 128))
    return canvas


def write_manifest(directory: Path, **overrides: object) -> None:
    manifest = yaml.safe_load((directory / "manifest.yaml").read_text())
    manifest.update(overrides)
    (directory / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))


def test_shipped_beacon() -> None:
    assert validate_pack(BEACON) == []


@pytest.mark.parametrize(
    "field",
    [
        "name",
        "artist",
        "grid",
        "palette",
        "anchors",
        "anchors.status_light",
        "anchors.chat_button",
        "anchors.baseline",
    ],
)
def test_every_required_field(pack: Path, field: str) -> None:
    path = pack / "manifest.yaml"
    manifest = yaml.safe_load(path.read_text())
    target = manifest
    parts = field.split(".")
    for part in parts[:-1]:
        target = target[part]
    del target[parts[-1]]
    path.write_text(yaml.safe_dump(manifest))
    assert f"missing: {field}" in validate_pack(pack)


@pytest.mark.parametrize(
    "field,value,error",
    [
        ("grid.rows", ["idle"] * 8, "grid: grid"),
        ("grid.frame", 64, "grid: grid"),
        ("grid.fps", 13, "grid: grid.fps"),
        ("grid.fps", True, "grid: grid.fps"),
        ("anchors.status_light.x", -1, "anchor: anchors.status_light"),
        ("anchors.status_light.w", 128, "anchor: anchors.status_light"),
        ("anchors.status_light.h", 0, "anchor: anchors.status_light"),
        ("anchors.chat_button.x", 128, "anchor: anchors.chat_button"),
        ("anchors.chat_button.y", 1.5, "anchor: anchors.chat_button"),
        ("anchors.baseline", 128, "anchor: anchors.baseline"),
        ("anchors.baseline", True, "anchor: anchors.baseline"),
        ("palette", ["#000000"] * 257, "palette: palette"),
        ("palette", ["red"], "palette: palette"),
        ("name", " ", "missing: name"),
    ],
)
def test_manifest_rules(pack: Path, field: str, value: object, error: str) -> None:
    path = pack / "manifest.yaml"
    manifest = yaml.safe_load(path.read_text())
    target = manifest
    parts = field.split(".")
    for part in parts[:-1]:
        target = target[part]
    target[parts[-1]] = value
    path.write_text(yaml.safe_dump(manifest))
    assert error in validate_pack(pack)


def test_off_grid(pack: Path) -> None:
    Image.new("RGBA", (511, 1024)).save(pack / "sheet.png")
    assert "grid: sheet" in validate_pack(pack)


def test_semitransparent_pixel(pack: Path) -> None:
    with Image.open(pack / "sheet.png") as source:
        image = source.convert("RGBA")
    image.putpixel((0, 0), (0, 0, 0, 128))
    image.save(pack / "sheet.png")
    assert "alpha: sheet.rgba" in validate_pack(pack)


def test_undeclared_colour(pack: Path) -> None:
    with Image.open(pack / "sheet.png") as source:
        image = source.convert("RGBA")
    image.putpixel((0, 0), (255, 0, 255, 255))
    image.save(pack / "sheet.png")
    assert "colour: sheet.rgba" in validate_pack(pack)


def test_corrupt_inputs(tmp_path: Path) -> None:
    assert "missing: manifest.yaml" in validate_pack(tmp_path)
    assert "pixels: sheet.rgba" in validate_pack(tmp_path)
    (tmp_path / "manifest.yaml").write_text("[unterminated")
    (tmp_path / "sheet.png").write_text("not an image")
    assert "missing: manifest.yaml" in validate_pack(tmp_path)
    assert "pixels: sheet.rgba" in validate_pack(tmp_path)


# --- T46 animated tier -------------------------------------------------


@pytest.mark.parametrize("frames", [4, 6, 12])
def test_frames_in_range_accepted(pack: Path, frames: int) -> None:
    manifest = yaml.safe_load((pack / "manifest.yaml").read_text())
    grid = {**manifest["grid"], "columns": frames}
    write_manifest(pack, frames=frames, grid=grid)
    resized_sheet(frames, len(STATES)).save(pack / "sheet.png")
    assert validate_pack(pack) == []


@pytest.mark.parametrize("frames", [3, 13])
def test_frames_outside_range_refused(pack: Path, frames: int) -> None:
    # columns matches frames so a range-only violation is isolated from the
    # separate "frames != grid.columns" mismatch rule.
    manifest = yaml.safe_load((pack / "manifest.yaml").read_text())
    grid = {**manifest["grid"], "columns": frames}
    write_manifest(pack, frames=frames, grid=grid)
    assert "grid: frames" in validate_pack(pack)


def test_frames_mismatched_with_columns_refused(pack: Path) -> None:
    # frames is in range but does not equal grid.columns (still 4).
    write_manifest(pack, frames=6)
    assert "grid: frames" in validate_pack(pack)


@pytest.mark.parametrize("fps", [6, 8, 12])
def test_fps_in_range_accepted(pack: Path, fps: int) -> None:
    manifest = yaml.safe_load((pack / "manifest.yaml").read_text())
    write_manifest(pack, fps=fps, grid={**manifest["grid"], "fps": fps})
    assert validate_pack(pack) == []


@pytest.mark.parametrize("fps", [5, 13])
def test_fps_outside_range_refused(pack: Path, fps: int) -> None:
    manifest = yaml.safe_load((pack / "manifest.yaml").read_text())
    write_manifest(pack, fps=fps, grid={**manifest["grid"], "fps": max(1, min(fps, 12))})
    assert "grid: fps" in validate_pack(pack)


def test_fps_mismatched_with_grid_fps_refused(pack: Path) -> None:
    # 8 is in the 6-12 range but grid.fps is still Beacon's 6.
    write_manifest(pack, fps=8)
    assert "grid: fps" in validate_pack(pack)


@pytest.mark.parametrize("tier", ["premium", "Standard", "ANIMATED", 1])
def test_invalid_tier_refused(pack: Path, tier: object) -> None:
    write_manifest(pack, tier=tier)
    assert "grid: tier" in validate_pack(pack)


@pytest.mark.parametrize("tier", ["standard", "animated"])
def test_valid_tier_values_do_not_by_themselves_fail(pack: Path, tier: str) -> None:
    write_manifest(pack, tier=tier)
    errors = validate_pack(pack)
    assert not any(e == "grid: tier" for e in errors)


def _animated_manifest(pack: Path, extra_rows: list[str]) -> None:
    manifest = yaml.safe_load((pack / "manifest.yaml").read_text())
    manifest["tier"] = "animated"
    manifest["grid"]["rows"] = list(STATES) + extra_rows
    (pack / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    resized_sheet(COLS, len(STATES) + len(extra_rows)).save(pack / "sheet.png")


def test_animated_pack_with_idle_variant_and_celebrate_passes(pack: Path) -> None:
    _animated_manifest(pack, ["idle_variant_1", "celebrate"])
    assert validate_pack(pack) == []


def test_animated_pack_with_two_idle_variants_passes(pack: Path) -> None:
    _animated_manifest(pack, ["idle_variant_1", "idle_variant_2", "celebrate"])
    assert validate_pack(pack) == []


def test_animated_pack_with_max_idle_variants_passes(pack: Path) -> None:
    extra_rows = [f"idle_variant_{n}" for n in range(1, 9)] + ["celebrate"]
    _animated_manifest(pack, extra_rows)
    assert validate_pack(pack) == []


def test_animated_pack_with_ninth_idle_variant_refused(pack: Path) -> None:
    # §8.7: at most 8 idle variants (idle_variant_1..idle_variant_8); a 9th is refused.
    extra_rows = [f"idle_variant_{n}" for n in range(1, 10)] + ["celebrate"]
    _animated_manifest(pack, extra_rows)
    assert "grid: grid.rows" in validate_pack(pack)


def test_animated_without_celebrate_refused(pack: Path) -> None:
    _animated_manifest(pack, ["idle_variant_1"])
    assert "grid: grid.rows" in validate_pack(pack)


def test_animated_without_idle_variant_refused(pack: Path) -> None:
    _animated_manifest(pack, ["celebrate"])
    assert "grid: grid.rows" in validate_pack(pack)


def test_animated_with_no_extra_rows_refused(pack: Path) -> None:
    manifest = yaml.safe_load((pack / "manifest.yaml").read_text())
    manifest["tier"] = "animated"
    (pack / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    assert "grid: grid.rows" in validate_pack(pack)


def test_extra_rows_on_standard_pack_refused(pack: Path) -> None:
    # tier absent (standard by default) but grid.rows carries an animated-tier row.
    manifest = yaml.safe_load((pack / "manifest.yaml").read_text())
    manifest["grid"]["rows"] = [*STATES, "idle_variant_1", "celebrate"]
    (pack / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    resized_sheet(COLS, len(STATES) + 2).save(pack / "sheet.png")
    assert "grid: grid.rows" in validate_pack(pack)


def test_extra_rows_explicit_standard_tier_refused(pack: Path) -> None:
    manifest = yaml.safe_load((pack / "manifest.yaml").read_text())
    manifest["tier"] = "standard"
    manifest["grid"]["rows"] = [*STATES, "idle_variant_1", "celebrate"]
    (pack / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    resized_sheet(COLS, len(STATES) + 2).save(pack / "sheet.png")
    assert "grid: grid.rows" in validate_pack(pack)


@pytest.mark.parametrize(
    "extra_rows",
    [
        ["idle_variant_2", "celebrate"],  # gap: no idle_variant_1
        ["idle_variant_1", "idle_variant_3", "celebrate"],  # gap between 1 and 3
        ["celebrate", "idle_variant_1"],  # celebrate not last
        ["idle_variant_1", "celebrate", "idle_variant_2"],  # celebrate not last
        ["idle_variant_1", "idle_variant_1"],  # duplicate/no advance
        ["mystery_row"],  # unknown name
    ],
)
def test_grid_rows_bad_shape_refused(pack: Path, extra_rows: list[str]) -> None:
    _animated_manifest(pack, extra_rows)
    assert "grid: grid.rows" in validate_pack(pack)


def test_old_pack_has_no_extra_rows_and_falls_back(pack: Path) -> None:
    """A pack with no `tier`/`frames`/`fps`/extra rows validates exactly as it
    does today: no idle variant, no celebrate, nothing to fall back from."""
    manifest = yaml.safe_load((pack / "manifest.yaml").read_text())
    assert "tier" not in manifest
    assert "frames" not in manifest
    assert "fps" not in manifest
    assert manifest["grid"]["rows"] == list(STATES)
    assert validate_pack(pack) == []
