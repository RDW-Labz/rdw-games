import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest
import yaml
from PIL import ImageDraw

from garage.avatars.grid import FRAME, STATES
from garage.avatars.pixel import Image, rgba_pixels
from garage.avatars.score import score_pack
from garage.avatars.validate import validate_pack

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "avatars/tools/portrait_to_pack.py"
EYES = ((104.0, 104.0), (136.0, 104.0))


def tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location("portrait_to_pack", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def fake_portrait() -> Image.Image:
    """Tiny synthetic bust: soft-edged hair, face, two dark eyes, collar and cardigan."""
    image = Image.new("RGBA", (240, 420), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((70, 40, 170, 150), fill=(190, 190, 195, 253))  # hair
    draw.ellipse((88, 70, 152, 150), fill=(228, 180, 150, 253))  # face
    for x, y in EYES:
        draw.ellipse((x - 6, y - 3, x + 6, y + 3), fill=(40, 30, 30, 253))
    draw.arc((106, 118, 134, 136), 20, 160, fill=(150, 60, 60, 253), width=3)  # smile
    draw.rectangle((110, 148, 130, 170), fill=(220, 175, 145, 253))  # neck
    draw.polygon([(40, 420), (60, 180), (180, 180), (200, 420)], fill=(80, 110, 85, 253))
    draw.polygon([(100, 180), (140, 180), (120, 260)], fill=(240, 232, 220, 253))  # collar
    draw.line((150, 60, 150, 250), fill=(90, 70, 40, 253), width=2)  # thin chain strand
    image.putpixel((5, 5), (255, 255, 255, 1))  # near-transparent halo speck
    return image


def frame(sheet: Image.Image, state: str, index: int) -> Image.Image:
    row = STATES.index(state)
    return sheet.crop((index * FRAME, row * FRAME, (index + 1) * FRAME, (row + 1) * FRAME))


@pytest.mark.parametrize(
    ("framing", "native"), [("head-shoulders", 128), ("head-shoulders", 64), ("full-body", 128)]
)
def test_portrait_pack_passes_validator(tmp_path: Path, framing: str, native: int) -> None:
    t = tool()
    opts = t.Options(framing=framing, native=native, bust=0.7, eyes=EYES, eye_size=(12.0, 6.0))
    report = t.build(fake_portrait(), tmp_path, opts, "Fixture", "OASIS", "Office / professional")
    assert report["errors"] == []
    assert validate_pack(tmp_path) == []
    assert 1 <= int(report["palette_size"]) <= 77
    manifest = yaml.safe_load((tmp_path / "manifest.yaml").read_text())
    assert set(manifest) == {"name", "artist", "grid", "palette", "anchors", "category"}
    assert manifest["grid"]["rows"] == list(STATES)
    rows = {row.name: row for row in score_pack(tmp_path).rows}
    assert rows["Anchor consistency"].value == "32/32 frames"
    assert rows["Body silhouette drift"].passed
    with Image.open(tmp_path / "sheet.png") as source:
        sheet = source.convert("RGBA")
    light = manifest["anchors"]["status_light"]
    box = (light["x"], light["y"], light["x"] + light["w"], light["y"] + light["h"])
    idle, asking = frame(sheet, "idle", 0), frame(sheet, "asking", 0)
    assert idle.crop(box).tobytes() != asking.crop(box).tobytes(), "status light must change"
    assert rgba_pixels(idle) != rgba_pixels(frame(sheet, "idle", 3)), "blink or bob must move"


def test_blink_edits_only_the_eyes(tmp_path: Path) -> None:
    t = tool()
    portrait = t.build_portrait(fake_portrait(), t.Options(bust=0.7, eyes=EYES, eye_size=(12, 6)))
    assert len(portrait.eyes) == 2
    open_grid = [row[:] for row in portrait.grid]
    closed = [row[:] for row in portrait.grid]
    t._close_eyes(closed, portrait)
    changed = {
        (x, y) for y, row in enumerate(closed) for x, ch in enumerate(row) if ch != open_grid[y][x]
    }
    assert changed, "closing the eyes must change pixels"
    assert all(
        any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in portrait.eyes) for x, y in changed
    )


def test_cli_writes_pack(tmp_path: Path) -> None:
    source = tmp_path / "portrait.png"
    fake_portrait().save(source)
    out = tmp_path / "pack"
    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            str(source),
            str(out),
            "--name",
            "Fixture",
            "--bust",
            "0.7",
            "--previews",
        ],
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    assert validate_pack(out) == []
    assert '"blink": false' in result.stdout  # no eye centres given: blink is skipped
    for name in ("preview-contact-4x.png", "preview-orb-1x.png", "preview-orb-2x.png"):
        assert (out / name).is_file()


def test_rejects_empty_portrait() -> None:
    t = tool()
    with pytest.raises(ValueError, match="no opaque pixels"):
        t.build_portrait(Image.new("RGBA", (64, 64)), t.Options())


def test_idle_breathe_moves_the_shoulder_band_by_one_px() -> None:
    """Idle bobs down, down, up, up (T26 upgrade #1): the two down frames and the two up
    frames sit 1 px apart, and that 1 px rise is exact for every row from the crown down
    to the neck (the head follows the shoulder rise), not a blur across several rows."""
    t = tool()
    portrait = t.build_portrait(fake_portrait(), t.Options(bust=0.7, eyes=EYES, eye_size=(12, 6)))
    bobs = [f[0] for f in t.MOTION["idle"]]
    assert bobs == [0, 0, 1, 1], "idle must breathe down, down, up, up"
    down = t._warp(portrait.grid, portrait, 0, 0)
    up = t._warp(portrait.grid, portrait, 1, 0)
    band_rows = range(2, portrait.neck_y - 1)
    checked = 0
    for y in band_rows:
        if any(ch != "." for ch in down[y]):
            assert up[y] == down[y + 1], f"row {y} must rise by exactly 1 px"
            checked += 1
    assert checked > 0, "fixture must have opaque rows above the neck to check"


AWAKE_STATES = (
    "idle",
    "working",
    "asking",
    "proposal_ready",
    "done",
    "needs_attention",
)


def test_blink_present_in_every_awake_state_but_not_when_already_closed() -> None:
    """T26 upgrade #2: every awake state has a real open/closed transition (the blink);
    paused and offline stay shut throughout, since their eyes are already closed."""
    t = tool()
    for state in AWAKE_STATES:
        closed_flags = [f[2] for f in t.MOTION[state]]
        assert True in closed_flags and False in closed_flags, (
            f"{state} must blink (open and closed frames both present)"
        )
    for state in ("paused", "offline"):
        assert all(f[2] for f in t.MOTION[state]), f"{state} must stay fully closed"


def test_blink_changes_pixels_only_inside_the_eye_boxes() -> None:
    """The built sheet's blink frame must differ from its matching open frame only inside the
    two eye boxes, end to end through the outline, rim and status light -- not merely at the
    token-grid level. needs_attention frames 0 and 2 share bob, tilt, prop position and status
    tone (only the closed flag differs), so any other change would be a real regression."""
    t = tool()
    portrait = t.build_portrait(fake_portrait(), t.Options(bust=0.7, eyes=EYES, eye_size=(12, 6)))
    colors_open = t.state_colors(portrait, "needs_attention", 0)
    colors_closed = t.state_colors(portrait, "needs_attention", 2)
    open_grid = t.build_grid(portrait, "needs_attention", 0)
    closed_grid = t.build_grid(portrait, "needs_attention", 2)
    from garage.avatars.pixel import render_grid

    open_img = render_grid(open_grid, colors_open, FRAME)
    closed_img = render_grid(closed_grid, colors_closed, FRAME)
    open_px = rgba_pixels(open_img)
    closed_px = rgba_pixels(closed_img)
    k = FRAME // portrait.n
    changed = {(i % FRAME, i // FRAME) for i in range(len(open_px)) if open_px[i] != closed_px[i]}
    assert changed, "the blink must change some pixels"
    for x, y in changed:
        nx, ny = x // k, y // k
        assert any(x0 <= nx <= x1 and y0 <= ny <= y1 for x0, y0, x1, y1 in portrait.eyes), (
            f"pixel {(x, y)} changed outside the eye boxes"
        )


def test_asking_tilts_the_head_and_keeps_a_clean_silhouette() -> None:
    """T26 upgrade #3: asking differs from idle only above the neck (the head tilt), and
    the warp must not tear the silhouette -- opaque pixel count stays close to idle's."""
    t = tool()
    portrait = t.build_portrait(fake_portrait(), t.Options(bust=0.7, eyes=EYES, eye_size=(12, 6)))
    idle = t.build_grid(portrait, "idle", 0)
    asking = t.build_grid(portrait, "asking", 0)
    below_neck_idle = [row[portrait.neck_y :] for row in zip(*idle, strict=True)]
    below_neck_asking = [row[portrait.neck_y :] for row in zip(*asking, strict=True)]
    assert below_neck_idle == below_neck_asking, "the tilt must not move anything below the neck"
    head_idle = [row[: portrait.neck_y] for row in zip(*idle, strict=True)]
    head_asking = [row[: portrait.neck_y] for row in zip(*asking, strict=True)]
    assert head_idle != head_asking, "asking must tilt the head away from idle"
    opaque_idle = sum(1 for row in idle for ch in row if ch != ".")
    opaque_asking = sum(1 for row in asking for ch in row if ch != ".")
    assert opaque_asking >= opaque_idle * 0.95, "the tilt must not tear holes in the head"
