import shutil
from pathlib import Path

import pytest
import yaml

from garage.avatars.pixel import Image
from garage.avatars.score import RunRecord, score_pack

BEACON = Path(__file__).resolve().parents[1] / "avatars/beacon"


def test_beacon_passes_every_bar_and_records_cost() -> None:
    score = score_pack(BEACON, RunRecord(12.5, 4.25))
    assert all(row.passed for row in score.rows if row.bar), score.to_markdown()
    assert len([row for row in score.rows if row.bar]) == 7
    text = score.to_markdown()
    assert "| Credits | 12.5 | — | — |" in text
    assert "| Minutes | 4.25 | — | — |" in text
    assert "32/32 frames" in text
    assert "not recorded" in score_pack(BEACON).to_markdown()


def test_bad_palette_and_moving_body_fail(tmp_path: Path) -> None:
    manifest = yaml.safe_load((BEACON / "manifest.yaml").read_text())
    manifest["palette"] = [f"#{i:06X}" for i in range(300)]
    (tmp_path / "manifest.yaml").write_text(yaml.safe_dump(manifest))
    with Image.open(BEACON / "sheet.png") as source:
        sheet = source.convert("RGBA")
    frame = sheet.crop((0, 0, 128, 128))
    sheet.paste((0, 0, 0, 0), (128, 0, 256, 128))
    sheet.paste(frame, (144, 0))
    sheet.save(tmp_path / "sheet.png")
    rows = {row.name: row for row in score_pack(tmp_path).rows}
    assert rows["Validator errors"].passed is False, "expected validator failure"
    assert "palette: palette" in rows["Validator errors"].value
    assert rows["Palette size vs Beacon"].passed is False, "expected palette bar failure"
    assert rows["Body silhouette drift"].passed is False, "expected moving body failure"
    assert rows["Anchor consistency"].passed is False, "expected moved anchor failure"


def test_invisible_pack_fails_readability(tmp_path: Path) -> None:
    shutil.copyfile(BEACON / "manifest.yaml", tmp_path / "manifest.yaml")
    Image.new("RGBA", (512, 1024)).save(tmp_path / "sheet.png")
    rows = {row.name: row for row in score_pack(tmp_path).rows}
    for name in (
        "64 px silhouette coverage",
        "64 px outline/rim contrast (dark)",
        "64 px outline/rim contrast (light)",
        "Anchor consistency",
    ):
        assert rows[name].passed is False, f"expected invisible pack failure: {name}"


def test_missing_pack_has_failed_rows(tmp_path: Path) -> None:
    score = score_pack(tmp_path)
    assert score.rows[0].passed is False, "expected missing pack failure"
    assert "missing: manifest.yaml" in score.rows[0].value


@pytest.mark.parametrize("value", [-1, float("nan"), float("inf")])
def test_invalid_run(value: float) -> None:
    with pytest.raises(ValueError, match="run credits and minutes must be finite and non-negative"):
        RunRecord(value, 0)


def test_corrupt_sheet_with_valid_manifest(tmp_path: Path) -> None:
    shutil.copyfile(BEACON / "manifest.yaml", tmp_path / "manifest.yaml")
    (tmp_path / "sheet.png").write_text("broken image")
    score = score_pack(tmp_path)
    assert score.rows[0].passed is False, "expected corrupt image failure"
    assert "pixels: sheet.rgba" in score.rows[0].value
    assert all(row.passed is False for row in score.rows if row.bar), score.to_markdown()
