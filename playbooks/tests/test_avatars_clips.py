"""clips_to_pack: per-state video frames to an animated-tier pack. Synthetic frames only."""

import importlib.util
import json
import math
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
import yaml
from PIL import Image, ImageDraw

from garage.avatars.grid import FRAME, STATES
from garage.avatars.validate import validate_pack

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "avatars/tools/clips_to_pack.py"
KEY = (250, 3, 250)
LOOP = 16  # synthetic clips repeat every 16 frames; frame 16 == frame 0
EXTRA = ["idle_variant_1", "idle_variant_2", "celebrate"]
ROWS = [*STATES, *EXTRA]


def tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location("clips_to_pack", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def character(
    dx: float = 0, dy: float = 0, arm: float = 0, size: int = 120, stretch: float = 1.0
) -> Image.Image:
    """A small owl-ish figure on the flat key: body, face, a green chest and one arm.

    `stretch` scales every shape's height about `top` (width unchanged), so two states can
    share a rig but differ in their own visible height, as a taller or shorter pose would."""
    image = Image.new("RGB", (size, size), KEY)
    draw = ImageDraw.Draw(image)
    cx, top = size / 2 + dx, 14 + dy

    def s(v: float) -> float:
        return top + v * stretch

    draw.ellipse((cx - 22, s(20), cx + 22, s(96)), fill=(120, 80, 45))  # body
    draw.ellipse((cx - 18, s(0), cx + 18, s(36)), fill=(200, 170, 130))  # head
    draw.rectangle((cx - 16, s(40), cx + 16, s(70)), fill=(70, 85, 50))  # sweater
    draw.ellipse((cx - 10, s(12), cx - 4, s(18)), fill=(30, 20, 15))  # eyes
    draw.ellipse((cx + 4, s(12), cx + 10, s(18)), fill=(30, 20, 15))
    if arm:
        draw.line((cx + 18, s(50), cx + 18 + arm, s(30)), fill=(120, 80, 45), width=6)
    return image


def clip(state: str) -> list[Image.Image]:
    """17 frames that start and end on the same resting pose; each state moves differently
    (idle_variant_1 reaches far right, celebrate jumps) so the shared box matters."""
    frames = []
    for i in range(LOOP + 1):
        phase = math.sin(2 * math.pi * i / LOOP)
        if state == "idle_variant_1":
            frames.append(character(arm=abs(phase) * 30))
        elif state == "celebrate":
            frames.append(character(dy=-abs(phase) * 10))
        elif state == "working":
            frames.append(character(dx=phase * 3))
        else:
            frames.append(character(dy=phase))
    return frames


def clips() -> dict[str, list[Image.Image]]:
    return {state: clip(state) for state in ROWS}


@pytest.fixture(scope="module")
def t() -> ModuleType:
    return tool()


@pytest.fixture(scope="module")
def built(t: ModuleType, tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, dict[str, Any]]:
    out = tmp_path_factory.mktemp("pack")
    base = character()
    opts = t.Options(frames=4, fps=6, colors=16)
    report = t.build(clips(), base, out, opts, "Fixture", "OASIS", "Pets")
    return out, report


@pytest.fixture(scope="module")
def built_plain(
    t: ModuleType, tmp_path_factory: pytest.TempPathFactory
) -> tuple[Path, dict[str, Any]]:
    out = tmp_path_factory.mktemp("plain")
    opts = t.Options(frames=4, fps=6, colors=16, props=False)
    return out, t.build(clips(), character(), out, opts, "Fixture", "OASIS")


def cell(sheet: Image.Image, row: int, col: int) -> Image.Image:
    return sheet.crop((col * FRAME, row * FRAME, (col + 1) * FRAME, (row + 1) * FRAME))


def mask(image: Image.Image) -> bytes:
    return image.getchannel("A").tobytes()


# --- keying -------------------------------------------------------------------------------


def test_detect_key_reads_the_border(t: ModuleType) -> None:
    assert t.detect_key(character()) == KEY


def test_key_out_removes_background_and_spill(t: ModuleType) -> None:
    image = Image.new("RGB", (4, 1))
    image.putdata([KEY, (120, 80, 45), (200, 50, 200), (245, 10, 240)])
    keyed = t.key_out(image, KEY)
    px = list(keyed.getdata())
    assert px[0][3] == 0 and px[3][3] == 0  # the key and a noisy key pixel vanish
    assert px[1] == (120, 80, 45, 255)  # the character is untouched
    r, g, b, a = px[2]  # an edge pixel half mixed with the key
    assert 0 < a < 255
    assert r <= g + 1 and b <= g + 1  # no magenta tint left on the edge


def test_key_out_refuses_a_grey_key(t: ModuleType) -> None:
    with pytest.raises(ValueError, match="saturated"):
        t.key_out(Image.new("RGB", (2, 2)), (128, 128, 128))


# --- frame picking ------------------------------------------------------------------------


def test_pick_frames_spaces_evenly_over_the_loop(t: ModuleType) -> None:
    assert t.pick_frames(17, 4, 16) == [0, 4, 8, 12]
    assert t.pick_frames(49, 12, 48) == list(range(0, 48, 4))
    assert t.pick_frames(30, 5, 25) == [0, 5, 10, 15, 20]  # 20 -> 25 (== 0) is one more step
    with pytest.raises(ValueError):
        t.pick_frames(3, 4)


def test_loop_end_finds_the_frame_that_matches_the_start(t: ModuleType) -> None:
    frames = [character(dy=-i) for i in range(12)] + [character()] + [character(dy=-3)] * 3
    sigs = [t._signature(im) for im in frames]
    assert t.loop_end(sigs) == 12
    still = [t._signature(character())] * 10
    assert t.loop_end(still) == 9  # nothing moves: keep the whole clip (latest tie)


# --- shared crop --------------------------------------------------------------------------


def test_shared_box_is_the_union_centred_on_rest(t: ModuleType) -> None:
    boxes = [(40, 20, 60, 90), (38, 10, 100, 92), (45, 25, 58, 80)]
    x0, y0, x1, y1 = t.shared_box(boxes, 50.0)
    assert (y0, y1) == (10, 92)
    assert x0 <= 38 and x1 >= 100  # every frame fits
    assert (x0 + x1) / 2 == 50  # the resting pose stays centred


def test_one_box_for_every_state(t: ModuleType, built_plain: tuple[Path, dict[str, Any]]) -> None:
    """Every clip starts on the same resting pose: with one shared crop, frame 0 has the exact
    same silhouette in every row, so the character never jumps or rescales between states."""
    out, report = built_plain
    with Image.open(out / "sheet.png") as source:
        sheet = source.convert("RGBA")
    first = [mask(cell(sheet, r, 0)) for r in range(len(ROWS))]
    assert all(m == first[0] for m in first)
    # the wide idle_variant_1 arm is inside the frame, not clipped at the cell edge
    stretch = ROWS.index("idle_variant_1")
    widest = max((cell(sheet, stretch, c).getbbox() or (0, 0, 0, 0)) for c in range(4))
    assert widest[2] < FRAME
    # the resting pose is horizontally centred in the frame
    x0, _, x1, _ = cell(sheet, 0, 0).getbbox() or (0, 0, 0, 0)
    assert abs((x0 + x1) / 2 - FRAME / 2) <= 2
    assert report["crop_box"][2] - report["crop_box"][0] > 60  # widened for the arm


# --- fill (decision #205) -----------------------------------------------------------------


def calm_clips() -> dict[str, list[Image.Image]]:
    """Every state only breathes (1 px) or sways: the silhouette's height barely changes."""
    out: dict[str, list[Image.Image]] = {}
    for r, state in enumerate(ROWS):
        frames = []
        for i in range(LOOP + 1):
            phase = math.sin(2 * math.pi * i / LOOP)
            frames.append(character(dx=phase * (r % 3), dy=phase))
        out[state] = frames
    return out


def bbox_fill(image: Image.Image) -> float:
    box = image.getchannel("A").point(lambda a: 255 if a >= 128 else 0).getbbox()
    assert box is not None
    return (box[3] - box[1]) / FRAME


def sheet_of(out: Path) -> Image.Image:
    with Image.open(out / "sheet.png") as source:
        return source.convert("RGBA")


def test_fill_lands_in_range(t: ModuleType, tmp_path: Path) -> None:
    """A fake sprite fills 0.80-0.90 of the cell height in every frame, measured on the
    sheet itself; without `fill` the same sprite fills more (the tool fits it to the frame),
    so a build that ignores `fill` fails here."""
    opts = t.Options(frames=4, fps=6, colors=16, props=False, fill=0.85)
    report = t.build(calm_clips(), character(), tmp_path, opts, "Fixture", "OASIS")
    assert report["errors"] == []
    sheet = sheet_of(tmp_path)
    fills = [bbox_fill(cell(sheet, r, c)) for r in range(len(ROWS)) for c in range(4)]
    assert all(t.MIN_FILL <= f <= t.MAX_FILL for f in fills), fills
    assert abs(max(fills) - 0.85) <= 3 / FRAME  # the 1 px breathing adds 2 px to the box
    assert report["fill"] == 0.85
    assert t.MIN_FILL <= report["fill_min"] <= report["fill_max"] <= t.MAX_FILL
    plain = t.build(
        calm_clips(),
        character(),
        tmp_path / "fit",
        t.Options(frames=4, fps=6, colors=16, props=False),
        "Fixture",
        "OASIS",
    )
    assert plain["fill_max"] > t.MAX_FILL


def test_fill_uses_one_shared_box(t: ModuleType, tmp_path: Path) -> None:
    """With `fill`, one box and one scale serve every frame: the resting pose is drawn at
    `fill` of the cell, and the jumping celebrate frames rise off the baseline at that same
    size, exactly as in the source clips. A per-frame box would re-seat every frame on the
    baseline and blow each one up to the full fill."""
    opts = t.Options(frames=4, fps=6, colors=16, props=False, fill=0.82)
    report = t.build(clips(), character(), tmp_path, opts, "Fixture", "OASIS")
    assert report["errors"] == []
    sheet = sheet_of(tmp_path)
    first = [mask(cell(sheet, r, 0)) for r in range(len(ROWS))]
    assert all(m == first[0] for m in first)  # frame 0 is the resting pose in every row
    assert abs(bbox_fill(cell(sheet, 0, 0)) - 0.82) <= 3 / FRAME  # the resting pose
    x0, _, x1, y1 = cell(sheet, 0, 0).getbbox() or (0, 0, 0, 0)
    assert abs((x0 + x1) / 2 - FRAME / 2) <= 2  # bottom-centred: horizontally centred...
    assert y1 >= FRAME - 10  # ...and feet anchored to the baseline, not floating
    jump = ROWS.index("celebrate")
    bottoms = [(cell(sheet, jump, c).getbbox() or (0, 0, 0, 0))[3] for c in range(4)]
    heights = [bbox_fill(cell(sheet, jump, c)) for c in range(4)]
    assert min(bottoms) < max(bottoms)  # in the air: off the baseline
    assert max(heights) - min(heights) <= 1 / FRAME  # same size in the air as on the ground
    assert report["fill_limit"] < t.MAX_FILL  # the jump takes some of the frame's height


def test_fill_uses_tallest_frame_in_the_pack(t: ModuleType, tmp_path: Path) -> None:
    """The scale comes from the tallest visible frame anywhere in the pack, not just the idle
    row: here `working` is the tall state and `idle` is a small one sharing the same rig. A
    build that calibrates on the idle row alone would either blow the tall state past the
    frame (refused) or leave it far outside [MIN_FILL, MAX_FILL]."""
    small, tall = 0.35, 1.0
    clips_h = {
        state: [character(size=200, stretch=tall if state == "working" else small)] * (LOOP + 1)
        for state in ROWS
    }
    opts = t.Options(frames=4, fps=6, colors=16, props=False, fill=0.85)
    report = t.build(clips_h, character(size=200), tmp_path, opts, "Fixture", "OASIS")
    assert report["errors"] == []
    sheet = sheet_of(tmp_path)
    idle_fill = max(bbox_fill(cell(sheet, ROWS.index("idle"), c)) for c in range(4))
    working_fill = max(bbox_fill(cell(sheet, ROWS.index("working"), c)) for c in range(4))
    assert t.MIN_FILL <= working_fill <= t.MAX_FILL
    assert idle_fill < t.MIN_FILL  # much shorter than the tallest frame in the pack


def test_options_fps_defaults_to_six(t: ModuleType) -> None:
    assert t.Options().fps == 6


def test_cli_fps_defaults_to_six(tmp_path: Path) -> None:
    frames_dir = tmp_path / "frames"
    for state, frames in clips().items():
        (frames_dir / state).mkdir(parents=True)
        for i, im in enumerate(frames):
            im.save(frames_dir / state / f"{i:04d}.png")
    base = tmp_path / "base.png"
    character().save(base)
    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            str(frames_dir),
            str(base),
            str(tmp_path / "pack"),
            "--name",
            "Fixture",
            "--frames",
            "4",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["fps"] == 6


def test_fill_refuses_a_move_that_would_leave_the_frame(t: ModuleType, tmp_path: Path) -> None:
    """Never clipped: at 0.90 the jump would rise past the top of the frame."""
    opts = t.Options(frames=4, fps=6, colors=16, props=False, fill=0.90)
    with pytest.raises(ValueError, match="does not fit"):
        t.build(clips(), character(), tmp_path, opts, "Fixture", "OASIS")


def test_fill_out_of_range_refuses(t: ModuleType, tmp_path: Path) -> None:
    for bad in (0.79, 0.91, 0.5, 1.0):
        with pytest.raises(ValueError, match="fill"):
            t.build(calm_clips(), character(), tmp_path, t.Options(frames=4, fill=bad), "F", "O")
    with pytest.raises(ValueError, match="fill"):
        t.place((0, 0, 100, 100), 0.95)
    with pytest.raises(ValueError, match="does not fit"):
        t.place((0, 0, 400, 100), 0.85)  # four times wider than tall cannot reach 0.85
    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            str(tmp_path),
            str(tmp_path / "b.png"),
            str(tmp_path / "o"),
            "--name",
            "F",
            "--fill",
            "0.95",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0


# --- the pack -----------------------------------------------------------------------------


def test_manifest_shape(built: tuple[Path, dict[str, Any]]) -> None:
    out, report = built
    manifest = yaml.safe_load((out / "manifest.yaml").read_text())
    assert manifest["tier"] == "animated"
    assert manifest["frames"] == manifest["grid"]["columns"] == 4
    assert manifest["fps"] == manifest["grid"]["fps"] == 6
    assert manifest["grid"]["rows"] == ROWS
    assert manifest["grid"]["frame"] == FRAME
    assert manifest["category"] == "Pets"
    assert set(manifest["anchors"]) == {"status_light", "chat_button", "baseline"}
    assert report["rows"] == ROWS
    assert all(len(p) == 4 for p in report["picked"].values())
    assert report["picked"]["idle"] == [0, 4, 8, 12]  # loop cut at frame 16 == frame 0


def test_validate_pack_passes(built: tuple[Path, dict[str, Any]]) -> None:
    out, report = built
    assert report["errors"] == []
    assert validate_pack(out) == []


def test_sheet_size_and_bytes(built: tuple[Path, dict[str, Any]]) -> None:
    out, report = built
    with Image.open(out / "sheet.png") as sheet:
        assert sheet.size == (FRAME * 4, FRAME * len(ROWS))
    assert (out / "sheet.png").stat().st_size <= 2 * 1024 * 1024
    assert report["sheet_bytes"] <= 2 * 1024 * 1024


def test_shrunk_sheet_reads_back_the_same(
    t: ModuleType, built: tuple[Path, dict[str, Any]], tmp_path: Path
) -> None:
    out, _ = built
    for name in ("manifest.yaml", "sheet.png"):
        (tmp_path / name).write_bytes((out / name).read_bytes())
    with Image.open(out / "sheet.png") as source:
        before = source.convert("RGBA").tobytes()
    t._shrink_sheet(tmp_path / "sheet.png")
    with Image.open(tmp_path / "sheet.png") as source:
        assert source.mode == "P"
        assert source.convert("RGBA").tobytes() == before
    assert validate_pack(tmp_path) == []


def test_pack_rows_orders_and_refuses(t: ModuleType) -> None:
    shuffled = ["celebrate", "idle_variant_2", *reversed(STATES), "idle_variant_1"]
    assert t.pack_rows(shuffled) == ROWS
    with pytest.raises(ValueError, match="celebrate"):
        t.pack_rows([*STATES, "idle_variant_1"])
    with pytest.raises(ValueError, match="idle variants"):
        t.pack_rows([*STATES, "idle_variant_2", "celebrate"])  # gap: no idle_variant_1
    with pytest.raises(ValueError, match="idle variants"):
        t.pack_rows([*STATES, *(f"idle_variant_{i}" for i in range(1, 10)), "celebrate"])
    with pytest.raises(ValueError, match="missing"):
        t.pack_rows([*STATES[1:], "idle_variant_1", "celebrate"])
    with pytest.raises(ValueError, match="unknown"):
        t.pack_rows([*STATES, "idle_variant_1", "celebrate", "dance"])


def test_build_refuses_out_of_range_frames_and_fps(t: ModuleType, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="frames"):
        t.build(clips(), character(), tmp_path, t.Options(frames=13), "F", "OASIS")
    with pytest.raises(ValueError, match="fps"):
        t.build(clips(), character(), tmp_path, t.Options(frames=4, fps=5), "F", "OASIS")


def test_cli_from_frame_folders(tmp_path: Path) -> None:
    frames_dir = tmp_path / "frames"
    for state, frames in clips().items():
        (frames_dir / state).mkdir(parents=True)
        for i, im in enumerate(frames):
            im.save(frames_dir / state / f"{i:04d}.png")
    base = tmp_path / "base.png"
    character().save(base)
    out = tmp_path / "pack"
    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            str(frames_dir),
            str(base),
            str(out),
            "--name",
            "Fixture",
            "--frames",
            "4",
            "--fps",
            "6",
            "--overview",
            str(tmp_path / "overview.png"),
            "--sequence-gif",
            str(tmp_path / "all.gif"),
            "--preview-dir",
            str(tmp_path / "preview"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert validate_pack(out) == []
    assert (tmp_path / "overview.png").exists() and (tmp_path / "all.gif").exists()
    assert sorted(p.stem for p in (tmp_path / "preview").glob("*.gif")) == sorted(ROWS)
