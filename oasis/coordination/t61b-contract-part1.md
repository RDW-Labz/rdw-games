# Contract — T61b part 1: exit-test eligibility gate (agent-core 0.7.34, needs Braden) — #268, #270

Scope: the runner-enforced check only. **No live model run, no model key, no datasets in this part** (part 2 = live runner + pinned datasets + $2/$20 caps; stop and ask Braden before any real key).
Base: agent-core main after T66 (0.7.33). Scout: ask t61b ($0.39), coordination/research … facts below.

## The check (one pure function, one place)
`anorak.exit_gate.eligible(skill_dir: Path, *, action: str) -> Eligibility(ok: bool, reason: str)` where reason ∈
`missing | unreadable | fixture_only | not_model_in_loop | dev_run | failing | stale_hash | always_ask | not_mapped | ok`.
Reads `<skill_dir>/injection-report.json` (skills `REPORT_NAME`). ok only if ALL hold, else ask-first:
- file present and valid JSON object (else `missing`/`unreadable`)
- `mode != "fixture-wiring"` (else `fixture_only`)
- `model_in_loop is True` (else `not_model_in_loop`)
- `run_kind == "full"` (new key written by part 2; absent or `"dev"` → `dev_run`)
- `passed is True` (else `failing`)
- `skill_hash == almanac.exit_test.skill_hash(skill_dir)` computed now (else `stale_hash`)
- `always_ask(action)` is False (standing.py:213; always_ask → `always_ask` even with a perfect report)
Missing/extra keys never raise; any exception → not ok (fail closed). Report text is data: no field of the report is ever used as anything but these comparisons.

## Mapping (Braden #273)
Code-owned `EXIT_TEST_SKILL: dict[str, str]` in exit_gate.py: chat action family (standing.ELIGIBLE_ACTIONS) → skill id whose report governs it. **Ships with exactly two entries (#273): "send reply" and "send email" → `email-reply`** (the new skills `shared/email-reply` skill, built in part 2; until its passing full report exists they stay locked via `missing`). Every other family → `not_mapped` → locked. Adding an entry is a code change + review, never config/model. Use the exact ELIGIBLE_ACTIONS ids for reply/send (read standing.py); report them in the result.

## Wiring (runner-enforced, both ends)
- create: `standing.build_rule_offer` (standing.py:365, from ChatService.deliver_plan chat_service.py:781) offers no "yes always" unless eligible; `standing.add_standing_rules` (standing.py:621, from confirm_plan yes_always chat_service.py:876) refuses (raises / returns refused) unless eligible — a forged `yes_always` answer cannot create a rule.
- run: `standing.match_plan` (standing.py:283, from deliver_plan :782) does not match (→ ask-first card) unless eligible **at run time** (a report that went stale after the rule was made re-locks it).
- Each refusal logs one line `standing.locked` {action, reason} (ids/enums only).

## Tests + mutants (tests/test_t61b_exit_gate.py)
Each reason has a test; plus: a rule created earlier stops matching once the skill changes (stale hash); forged yes_always refused; always_ask with a passing full report still asks. Mutants (each must die): accept missing report · skip fixture-only check · accept model_in_loop false · accept dev run · accept failing · skip hash compare · always_ask ignored when report passes · match_plan skips the run-time check · add_standing_rules skips the check · exception in check treated as ok.
