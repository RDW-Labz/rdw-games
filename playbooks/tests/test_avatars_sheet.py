from pathlib import Path

import pytest

from garage.avatars.pixel import Image
from garage.avatars.sheet import contact_sheet


@pytest.mark.parametrize("dark", [False, True])
def test_six_cells_and_rendered_labels(tmp_path: Path, dark: bool) -> None:
    images = [Image.new("RGBA", (32, 32), (i * 30, 120, 80, 255)) for i in range(6)]
    output = contact_sheet(images, tmp_path / "sheet.png", dark)
    with Image.open(output) as sheet:
        assert sheet.size == (1632, 1176)
        background = sheet.getpixel((0, 0))
        labels = []
        for i in range(6):
            x, y = 24 + i % 3 * 536, 24 + i // 3 * 576
            assert sheet.getpixel((x + 256, y + 40 + 256)) == (i * 30, 120, 80)
            label = sheet.crop((x, y, x + 40, y + 40))
            assert any(pixel != background for pixel in label.getdata())
            labels.append(label.tobytes())
        assert len(set(labels)) == 6  # actually numbered, not six identical labels


def test_transparency_paths_and_aspect_ratio(tmp_path: Path) -> None:
    source = tmp_path / "candidate.png"
    Image.new("RGBA", (10, 20), (250, 0, 0, 255)).save(source)
    output = contact_sheet([source], tmp_path / "out.png", True)
    with Image.open(output) as sheet:
        assert sheet.getpixel((24, 100)) == sheet.getpixel((0, 0))
        assert sheet.getpixel((24 + 256, 100)) == (250, 0, 0)


def test_empty_contact_sheet(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="contact sheet needs at least one image"):
        contact_sheet([], tmp_path / "empty.png", False)
