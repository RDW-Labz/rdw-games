"""The shared venture list: code -> full name (DECISIONS.md #61)."""

from __future__ import annotations

import tomllib
from pathlib import Path

import pytest

from garage.ventures import (
    VentureDataError,
    _load_from,
    _ventures_file,
    load_ventures,
    venture_name,
)

EXPECTED = {
    "holdings": "Cluer Holdings",
    "rdw": "RDW LLC",
    "bin-there": "Bin-There Bought That",
    "alpena-trucking": "Alpena Trucking",
    "wk-trucking": "Wayne Kelley Trucking",
    "jmac": "JMAC Construction",
    "gold-run": "Gold Run LLC",
    "glory-road": "Glory Road",
    "evage": "Evage LLC",
}


def test_load_ventures_has_exactly_the_nine_codes_and_names() -> None:
    ventures = load_ventures()
    assert ventures == EXPECTED
    assert list(ventures) == list(EXPECTED)


def test_venture_name_returns_the_full_name() -> None:
    assert venture_name("bin-there") == "Bin-There Bought That"


def test_venture_name_returns_the_code_itself_when_unknown() -> None:
    assert venture_name("nope") == "nope"


def test_ventures_file_prefers_the_packaged_copy_when_present(tmp_path: Path) -> None:
    package_file = tmp_path / "package" / "ventures.yaml"
    package_file.parent.mkdir(parents=True)
    package_file.write_text("ventures: []\n")
    repo_file = tmp_path / "repo" / "ventures.yaml"
    repo_file.parent.mkdir(parents=True)

    assert _ventures_file(package_file, repo_file) == package_file


def test_ventures_file_falls_back_to_the_repo_copy_when_unpackaged(tmp_path: Path) -> None:
    package_file = tmp_path / "package" / "ventures.yaml"  # never created
    repo_file = tmp_path / "repo" / "ventures.yaml"
    repo_file.parent.mkdir(parents=True)
    repo_file.write_text("ventures: []\n")

    assert _ventures_file(package_file, repo_file) == repo_file


def _write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "ventures.yaml"
    path.write_text(body)
    return path


def test_load_from_rejects_a_bad_code(tmp_path: Path) -> None:
    path = _write(tmp_path, "ventures:\n  - code: Bad_Code\n    name: Bad\n")
    with pytest.raises(VentureDataError):
        _load_from(path)


def test_load_from_rejects_a_duplicate_code(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        "ventures:\n"
        "  - code: holdings\n    name: Cluer Holdings\n"
        "  - code: holdings\n    name: Something Else\n",
    )
    with pytest.raises(VentureDataError):
        _load_from(path)


def test_load_from_rejects_a_duplicate_name_case_insensitive(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        "ventures:\n"
        "  - code: holdings\n    name: Cluer Holdings\n"
        "  - code: rdw\n    name: cluer holdings\n",
    )
    with pytest.raises(VentureDataError):
        _load_from(path)


def test_load_from_rejects_an_empty_name(tmp_path: Path) -> None:
    path = _write(tmp_path, "ventures:\n  - code: holdings\n    name: ''\n")
    with pytest.raises(VentureDataError):
        _load_from(path)


def test_load_from_rejects_a_multi_line_name(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        "ventures:\n  - code: holdings\n    name: |\n      Line one\n      Line two\n",
    )
    with pytest.raises(VentureDataError):
        _load_from(path)


def test_pyproject_force_includes_ventures_yaml() -> None:
    pyproject_path = Path(__file__).resolve().parents[1] / "pyproject.toml"
    with pyproject_path.open("rb") as handle:
        config = tomllib.load(handle)

    force_include = config["tool"]["hatch"]["build"]["targets"]["wheel"]["force-include"]
    assert force_include["ventures.yaml"] == "garage/ventures.yaml"
