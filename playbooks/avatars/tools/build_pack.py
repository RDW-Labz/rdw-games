"""Build-time CLI; run with uv run from the repository root."""

import argparse
import importlib
import importlib.util
import json
import sys
from pathlib import Path

from garage.avatars.pack import render_pack


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a trusted local Character module's pack")
    parser.add_argument(
        "character_module",
        metavar="CHARACTER_MODULE",
        help="Python file or import name exporting CHARACTER",
    )
    parser.add_argument("out_dir", type=Path, metavar="OUT_DIR")
    args = parser.parse_args()
    if args.character_module.endswith(".py"):
        spec = importlib.util.spec_from_file_location("avatar_character", args.character_module)
        if spec is None or spec.loader is None:
            parser.error("cannot load character module")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    else:
        module = importlib.import_module(args.character_module)
    result = render_pack(module.CHARACTER, args.out_dir)
    print(
        json.dumps(
            {
                "out_dir": str(result.out_dir),
                "files": [str(p) for p in result.files],
                "palette_size": result.palette_size,
            }
        )
    )


if __name__ == "__main__":
    main()
