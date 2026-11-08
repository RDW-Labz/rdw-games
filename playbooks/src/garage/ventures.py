"""Loads the shared venture list: short codes to full names.

Venture codes are stable keys used by the onboarding profile writer
(`profile.yaml`'s `ventures[]`), by drawers, and by the role gate; a name
may change freely, but a code never changes without a decision
(DECISIONS.md #61). The single source of truth is ``ventures.yaml`` in the
repo root, read with YAML's safe loader. The wheel force-includes the same
file under ``garage/ventures.yaml`` (see ``pyproject.toml``) so an
installed, vendored copy of this package can load its own data without a
repo checkout nearby.
"""

from __future__ import annotations

import re
from functools import cache
from pathlib import Path
from typing import Any

import yaml

#: src/garage/ventures.py -> garage -> src -> repo root
_REPO_VENTURES_FILE = Path(__file__).resolve().parents[2] / "ventures.yaml"
#: src/garage/ventures.py -> garage (force-included in the wheel)
_PACKAGE_VENTURES_FILE = Path(__file__).resolve().parent / "ventures.yaml"

_MAX_YAML_BYTES = 200_000
_MAX_NAME_LEN = 80
_CODE_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")


class VentureDataError(ValueError):
    """``ventures.yaml`` is missing or malformed."""


def _ventures_file(package_file: Path, repo_file: Path) -> Path:
    """Prefer the packaged copy of ventures.yaml, falling back to the repo."""
    if package_file.is_file():
        return package_file
    return repo_file


VENTURES_FILE = _ventures_file(_PACKAGE_VENTURES_FILE, _REPO_VENTURES_FILE)


def _load_from(path: Path) -> dict[str, str]:
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise VentureDataError(f"Cannot read {path}: {exc}") from exc
    if len(payload) > _MAX_YAML_BYTES:
        raise VentureDataError(f"{path} exceeds the ventures data size limit")
    try:
        data: Any = yaml.safe_load(payload)
    except yaml.YAMLError as exc:
        raise VentureDataError(f"Invalid YAML in {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise VentureDataError(f"{path} must contain a YAML mapping")
    items = data.get("ventures")
    if not isinstance(items, list) or not items:
        raise VentureDataError(f"{path} must have a non-empty 'ventures' list")

    result: dict[str, str] = {}
    seen_names: dict[str, str] = {}
    for item in items:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("code"), str)
            or not isinstance(item.get("name"), str)
        ):
            raise VentureDataError(f"{path}: each venture needs a string 'code' and 'name'")
        code: str = item["code"]
        name: str = item["name"]
        if not _CODE_RE.match(code):
            raise VentureDataError(f"{path}: invalid venture code {code!r}")
        if not name or "\n" in name or len(name) > _MAX_NAME_LEN:
            raise VentureDataError(f"{path}: invalid venture name for code {code!r}")
        if code in result:
            raise VentureDataError(f"{path}: duplicate venture code {code!r}")
        lowered = name.lower()
        if lowered in seen_names:
            raise VentureDataError(
                f"{path}: duplicate venture name {name!r} (also used by {seen_names[lowered]!r})"
            )
        seen_names[lowered] = name
        result[code] = name
    return result


@cache
def load_ventures() -> dict[str, str]:
    """Load ``ventures.yaml``: code -> full name, in file order."""
    return _load_from(VENTURES_FILE)


def venture_name(code: str) -> str:
    """Return the full name for ``code``, or ``code`` itself when unknown."""
    return load_ventures().get(code, code)


__all__ = [
    "VENTURES_FILE",
    "VentureDataError",
    "load_ventures",
    "venture_name",
]
