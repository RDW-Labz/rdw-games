"""Render the reviewed T01 template into a checkout, without touching other files."""

from __future__ import annotations

import argparse
import re
from collections.abc import Sequence
from pathlib import Path

from garage.repositories import REPOSITORIES

TEMPLATES = Path(__file__).resolve().parents[2] / "template"
PYTHON_CHECKS = """uv sync --locked
uv run --no-sync pytest -q
uv run --no-sync ruff check .
uv run --no-sync mypy --strict src"""
DESKTOP_CHECKS = """npm ci
npm test
npm run lint
npm run typecheck
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run tauri build -- --no-bundle"""


def render(repo: str, templates: Path = TEMPLATES) -> dict[Path, bytes]:
    """Produce common files plus exactly one language overlay."""
    values = {"repo": repo, **REPOSITORIES[repo]}
    values["checks"] = DESKTOP_CHECKS if repo == "desktop-app" else PYTHON_CHECKS
    overlay = "desktop" if repo == "desktop-app" else "python"
    result: dict[Path, bytes] = {}
    for layer in ("common", overlay):
        folder = templates / layer
        if not folder.is_dir():
            raise ValueError(f"Missing template layer: {layer}")
        for source in sorted(folder.rglob("*")):
            if source.is_symlink():
                raise ValueError("Template symlinks are not allowed")
            if not source.is_file():
                continue
            relative = source.relative_to(folder)
            path = Path(str(relative).replace("__module__", values["module"]))
            data = source.read_bytes()
            if source.suffix == ".tmpl":
                path = path.with_suffix("")
                content = data.decode("utf-8")
                for key, value in values.items():
                    content = content.replace("{{" + key + "}}", value)
                if re.search(r"\{\{[a-z_]+\}\}", content):
                    raise ValueError(f"Unresolved template token: {relative}")
                data = content.encode("utf-8")
            if path in result:
                raise ValueError(f"Duplicate template output: {path}")
            result[path] = data
    return result


def _validate_destination(target: Path, relative: Path) -> Path:
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Template output must be relative to the checkout")
    destination = target / relative
    for part in (destination, *destination.parents):
        if part.is_symlink():
            raise ValueError(f"Refusing a symlink destination: {part}")
    if destination.exists() and not destination.is_file():
        raise ValueError(f"Expected a file: {destination}")
    for parent in destination.parents:
        if parent.exists() and not parent.is_dir():
            raise ValueError(f"Expected a directory: {parent}")
    return destination


def apply_template(
    repo: str, target: Path, *, write: bool = False, templates: Path = TEMPLATES
) -> list[Path]:
    """List drift, optionally writing only managed files; preserve changelog history."""
    expected = render(repo, templates)
    changes: list[tuple[Path, Path, bytes]] = []
    # Preflight every destination before any mutation.
    for relative, data in expected.items():
        destination = _validate_destination(target.absolute(), relative)
        if relative == Path("CHANGELOG.md") and destination.exists():
            continue
        if not destination.exists() or destination.read_bytes() != data:
            changes.append((relative, destination, data))
    if write:
        for _, destination, data in changes:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
    return [relative for relative, _, _ in changes]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", choices=sorted(REPOSITORIES), required=True)
    parser.add_argument("--target", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Report drift without writes")
    mode.add_argument("--write", action="store_true", help="Apply managed scaffold files")
    args = parser.parse_args(argv)
    try:
        changed = apply_template(args.repo, args.target, write=args.write)
    except (OSError, ValueError) as exc:
        parser.exit(2, f"Template error: {exc}\n")
    for path in changed:
        print(path.as_posix())
    return 1 if changed and not args.write else 0


if __name__ == "__main__":
    raise SystemExit(main())
