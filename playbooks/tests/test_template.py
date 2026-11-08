import shutil
import tomllib
from pathlib import Path

import pytest

from garage.repositories import REPOSITORIES
from garage.template import TEMPLATES, apply_template, main, render


@pytest.mark.parametrize("repo", sorted(REPOSITORIES))
def test_all_nine_scaffolds_and_repeat_application(repo: str, tmp_path: Path) -> None:
    target = tmp_path / repo
    assert apply_template(repo, target, write=True)
    for name in (
        "README.md",
        "AGENTS.md",
        "AGENTS.workspace.md",
        "CHANGELOG.md",
        ".gitignore",
        ".github/workflows/ci.yml",
    ):
        assert (target / name).is_file()
    for name in ("docs", "src", "tests"):
        assert (target / name).is_dir()
    if repo == "desktop-app":
        assert (target / "src-tauri/Cargo.toml").is_file()
        assert (target / "package.json").is_file()
        assert not (target / "pyproject.toml").exists()
    else:
        project = tomllib.loads((target / "pyproject.toml").read_text())
        assert project["project"]["name"] == repo
        module = REPOSITORIES[repo]["module"]
        assert (target / "src" / module / "__init__.py").is_file()
        assert not (target / "package.json").exists()
    assert apply_template(repo, target) == []
    assert apply_template(repo, target, write=True) == []


def test_preserves_authored_files_and_changelog(tmp_path: Path) -> None:
    target = tmp_path / "skills"
    for name in (
        "docs/formats.md",
        "catalog/custom.yaml",
        "agent-template/agent.yaml",
        "personal/example/SKILL.md",
        "src/almanac/custom.py",
        "CHANGELOG.md",
    ):
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("authored content\n")
    before = {p: p.read_bytes() for p in target.rglob("*") if p.is_file()}
    apply_template("skills", target, write=True)
    assert all(path.read_bytes() == data for path, data in before.items())


def test_check_detects_drift_without_mutation(tmp_path: Path) -> None:
    target = tmp_path / "remote"
    apply_template("remote", target, write=True)
    workflow = target / ".github/workflows/ci.yml"
    workflow.write_text("broken\n")
    args = ["--repo", "remote", "--target", str(target)]
    assert main([*args, "--check"]) == 1
    assert workflow.read_text() == "broken\n"
    assert main([*args, "--write"]) == 0
    assert main([*args, "--check"]) == 0


def test_missing_checkout_check_does_not_create_it(tmp_path: Path) -> None:
    target = tmp_path / "remote"
    assert main(["--repo", "remote", "--target", str(target), "--check"]) == 1
    assert not target.exists()


def test_symlink_destination_refused_before_any_write(tmp_path: Path) -> None:
    target = tmp_path / "remote"
    outside = tmp_path / "outside"
    target.mkdir()
    outside.mkdir()
    (target / "tests").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        apply_template("remote", target, write=True)
    assert not (target / "README.md").exists()
    assert list(outside.iterdir()) == []


def test_template_errors_refuse_partial_writes(tmp_path: Path) -> None:
    templates = tmp_path / "templates"
    shutil.copytree(TEMPLATES, templates)
    (templates / "common/README.md.tmpl").write_text("{{unknown_token}}")
    with pytest.raises(ValueError, match="Unresolved"):
        apply_template("remote", tmp_path / "remote", write=True, templates=templates)
    assert not (tmp_path / "remote").exists()


def test_repo_specific_rules_remain_in_rendered_policy() -> None:
    for repo, metadata in REPOSITORIES.items():
        text = render(repo)[Path("AGENTS.md")].decode()
        assert metadata["repo_rules"] in text
        assert "AGENTS.workspace.md" in text


def test_registry_covers_exactly_the_authorized_repos() -> None:
    assert set(REPOSITORIES) == {
        "agent-core",
        "remote",
        "skills",
        "connectors",
        "rag-pipeline",
        "agent-amber",
        "agent-michael",
        "desktop-app",
        "playbooks",
    }


def test_non_directory_parent_refused_before_any_write(tmp_path: Path) -> None:
    target = tmp_path / "remote"
    target.mkdir()
    (target / "tests").write_text("keep me")
    with pytest.raises(ValueError, match="directory"):
        apply_template("remote", target, write=True)
    assert not (target / "README.md").exists()
    assert (target / "tests").read_text() == "keep me"
