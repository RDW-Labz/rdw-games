"""Load the dev2 tools as modules for the Mac tests (they are scripts, not a package)."""

import importlib.machinery
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "bin"))


def load(rel: str, name: str):
    path = HERE / rel
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses look the module up by name
    loader.exec_module(module)
    return module


def config() -> dict:
    common = load("bin/hermes_dev2_common.py", "hermes_dev2_common")
    return common.parse_config((HERE / "config.conf").read_text())
