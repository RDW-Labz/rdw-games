"""Build-time CLI; run with uv run from the repository root."""

import argparse
import json
from pathlib import Path

from garage.avatars.score import RunRecord, score_pack


def main() -> None:
    parser = argparse.ArgumentParser(description="Report advisory pack scores; never auto-reject")
    parser.add_argument("directory", type=Path, metavar="DIR")
    parser.add_argument(
        "--run", type=Path, metavar="RUN.json", help="JSON with numeric credits and minutes"
    )
    args = parser.parse_args()
    run = RunRecord(**json.loads(args.run.read_text())) if args.run else None
    print(score_pack(args.directory, run).to_markdown())


if __name__ == "__main__":
    main()
