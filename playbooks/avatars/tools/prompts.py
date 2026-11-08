"""Build-time CLI; run with uv run from the repository root."""

import argparse
import json
from pathlib import Path

import yaml

from garage.avatars.prompts import candidate_prompts


def main() -> None:
    parser = argparse.ArgumentParser(description="Write six original avatar prompts")
    parser.add_argument("brief", type=Path, metavar="BRIEF.yaml")
    args = parser.parse_args()
    brief = yaml.safe_load(args.brief.read_text())
    if not isinstance(brief, dict):
        parser.error("brief must be a mapping")
    print(json.dumps(candidate_prompts(brief), indent=2))


if __name__ == "__main__":
    main()
