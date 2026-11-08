"""Build-time CLI; run with uv run from the repository root."""

import argparse
from pathlib import Path

from garage.avatars.validate import validate_pack


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate a pack with the Rig's rules")
    parser.add_argument("directory", type=Path, metavar="DIR")
    args = parser.parse_args()
    errors = validate_pack(args.directory)
    print("\n".join(errors) if errors else "valid")
    raise SystemExit(bool(errors))


if __name__ == "__main__":
    main()
