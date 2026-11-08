"""Smoke test: the package imports and reports its version."""

import garage


def test_package_imports() -> None:
    assert garage.__name__ == "garage"


def test_version_is_declared() -> None:
    assert garage.__version__ == "0.1.0"
