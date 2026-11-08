"""The onboarding-v1 skill checker (``skill.yaml``'s ``checker: onboarding_profile_complete``).

Plain code, never a model (decision #64): a person's ``profile.yaml`` is
"complete" only when (1) every field ``garage.onboarding.writer.REQUIRED_FIELDS``
lists is present and non-empty, (2) the stored profile loads and validates
through ``anorak.memory.ProfileStore`` at all, and (3) every code in its
``ventures`` list exists in ``garage.ventures.load_ventures()``. It never
trusts ``anorak.loop.CheckContext.result`` -- a step's own reported output is
not proof anything was actually written, so this always re-reads
``profile.yaml`` from the store instead.
"""

from __future__ import annotations

from anorak.loop import CheckContext, Checker, CheckResult
from anorak.memory import MemoryStoreError, ProfileStore

from garage.onboarding.writer import REQUIRED_FIELDS
from garage.ventures import load_ventures

CHECKER_NAME = "onboarding_profile_complete"


def _is_empty(value: object) -> bool:
    return value is None or value == "" or value == [] or value == {}


def make_profile_complete_checker(store: ProfileStore) -> Checker:
    """Build the ``onboarding_profile_complete`` checker for one person's ``store``."""

    async def profile_complete(context: CheckContext) -> CheckResult:
        try:
            profile = store.load()
        except (FileNotFoundError, MemoryStoreError):
            return CheckResult(passed=False, failure="profile.yaml is missing or unreadable")

        data = profile.to_dict()
        missing = [field for field in REQUIRED_FIELDS if _is_empty(data.get(field))]
        if missing:
            return CheckResult(
                passed=False, failure=f"Missing required field(s): {', '.join(missing)}"
            )

        ventures_raw = data.get("ventures")
        codes = (
            [code for code in ventures_raw if isinstance(code, str)]
            if isinstance(ventures_raw, list)
            else []
        )
        known = load_ventures()
        unknown = [code for code in codes if code not in known]
        if unknown:
            return CheckResult(
                passed=False, failure=f"Unknown venture code(s): {', '.join(unknown)}"
            )

        return CheckResult(passed=True)

    return profile_complete


__all__ = ["CHECKER_NAME", "make_profile_complete_checker"]
