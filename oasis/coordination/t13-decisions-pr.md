# T13: mirror watch answers and keep access role admin-set

Branch: `codex/t13-profile-decisions`  
Base: `main`  
Repository: `playbooks`

## Problem and result

The onboarding implementation must make the approved profile decisions concrete. This PR keeps `profile.yaml.watch_answers` as the canonical store for Yes/No page-watch decisions, leaves Not now unsaved so it prompts again, removes `access_level` from onboarding input, defaults new profiles to `member`, and preserves an existing `admin` value for provisioning by Braden.

## Validation

Pending worker completion and coordinator rerun:

```text
uv sync --locked
uv run --no-sync pytest -q
uv run --no-sync ruff check .
uv run --no-sync mypy --strict src
git diff --check
```

The user-zero Rig walkthrough and profile review remain human acceptance checks after the Rig service and companion are available.
