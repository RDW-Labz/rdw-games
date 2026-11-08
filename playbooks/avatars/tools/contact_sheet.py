"""Build-time CLI; run with uv run from the repository root."""

import argparse
from pathlib import Path

from garage.avatars.sheet import contact_sheet


def main() -> None:
    parser = argparse.ArgumentParser(description="Build light and dark contact sheets")
    parser.add_argument("directory", type=Path, metavar="DIR")
    args = parser.parse_args()
    images = sorted(
        p for p in args.directory.glob("*.png") if not p.name.startswith("contact-sheet")
    )
    for dark, name in ((False, "contact-sheet.png"), (True, "contact-sheet-dark.png")):
        print(contact_sheet(images, args.directory / name, dark))


if __name__ == "__main__":
    main()
