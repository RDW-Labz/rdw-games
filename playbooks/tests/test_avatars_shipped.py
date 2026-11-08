"""Every avatar pack shipped under `packs/` passes validate_pack and loads correctly.

More motion packs (decisions #195, #198, #205, #272): fantasy-03, fantasy-06,
fantasy-09 and pets-01 to pets-05 under `garage/avatars/packs/<id>/`, built
with the 0.5.2 fill tool (#205); plus the 96 T78 r1 still packs (#338).
"""

import importlib.resources
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import Any

import pytest
import yaml

from garage.avatars.validate import validate_pack

PACKS: Path = Path(__file__).resolve().parents[1] / "src" / "garage" / "avatars" / "packs"
SHIPPED: list[str] = sorted(path.name for path in PACKS.iterdir() if path.is_dir())
MOTION_IDS: tuple[str, ...] = (
    "fantasy-03", "fantasy-06", "fantasy-09", "pets-01",
    "pets-02", "pets-03", "pets-04", "pets-05",
)
#: T78 (decision #338): eight r1 themes x 12 still looks, built by stills_to_pack.
R1_THEMES: tuple[str, ...] = (
    "arcade", "space", "desert", "robot", "office", "pets", "fantasy", "hitchhiker",
)
R1_IDS: tuple[str, ...] = tuple(f"{theme}-{n:02d}-r1" for theme in R1_THEMES for n in range(1, 13))
EXPECTED_IDS: tuple[str, ...] = MOTION_IDS + R1_IDS


def test_shipped_ids_are_the_eight_more_motion_packs_plus_the_96_r1_stills() -> None:
    assert set(SHIPPED) == set(EXPECTED_IDS)
    assert len(R1_IDS) == 96


@pytest.mark.parametrize("pack_id", EXPECTED_IDS)
def test_shipped_pack_passes_validator(pack_id: str) -> None:
    assert validate_pack(PACKS / pack_id) == []


@pytest.mark.parametrize("pack_id", EXPECTED_IDS)
def test_shipped_pack_manifest_loads(pack_id: str) -> None:
    path: Path = PACKS / pack_id / "manifest.yaml"
    manifest: Any = yaml.safe_load(path.read_text())
    assert isinstance(manifest, dict)
    if "id" in manifest:
        assert manifest["id"] == pack_id
    else:
        assert "grid" in manifest or "states" in manifest


@pytest.mark.parametrize("pack_id", EXPECTED_IDS)
def test_shipped_pack_holds_exactly_manifest_and_sheet(pack_id: str) -> None:
    pack_dir = PACKS / pack_id
    assert sorted(p.name for p in pack_dir.iterdir()) == [
        "manifest.yaml", "sheet.png"
    ]


@pytest.mark.parametrize("pack_id", EXPECTED_IDS)
def test_shipped_pack_is_package_data(pack_id: str) -> None:
    manifest_resource: Traversable = (
        importlib.resources.files("garage")
        / "avatars"
        / "packs"
        / pack_id
        / "manifest.yaml"
    )
    assert manifest_resource.is_file()
    sheet_resource: Traversable = (
        importlib.resources.files("garage")
        / "avatars"
        / "packs"
        / pack_id
        / "sheet.png"
    )
    assert sheet_resource.is_file()
