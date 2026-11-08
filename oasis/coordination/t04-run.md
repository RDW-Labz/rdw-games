# T04 orchestration record

Authorized by Braden: start T04 immediately after the single Google probe attempt,
without waiting for T03 review. Google returned invalid_client; T03 stays draft.

Contract: coordination/t04-contract.md. Native dispatch reviewer: READY after
clarifying serialized versus structured bodies and case-insensitive Content-Type.

External runner: project-swarm preflight passed the two-job smoke manifest.
Launch stopped before worker execution because the installed Claude CLI lacked
required --restricted, --safe-mode, --tools, --permission-prompts,
--strict-mcp-config, --no-session-persistence and --no-chrome flags. The runner's
doctor had said compatible, so doctor alone was not live evidence. No isolation
flag was removed and no external worker answered. Older project-swarm checkout
also lacked preflight; used the existing newer /private/tmp/oasis-t01-swarm runner.

Fallback: two concurrent native agents, t04_implementation and t04_corpus, with
disjoint files in the contract. Native list_agents confirmed both running;
external running count was zero. Coordinator owns integration/checks/docs/git/PR.
No claims of measured speedup or external provider live verification.

Final integration: independent review found hostile instance/metaclass exception
paths, recursive envelope over-masking, and collision counting. Fixed with
regressions and independently reproduced clean. Coordinator also reproduced and
fixed malformed Unicode form encoding and partial URL count handling.
Final local validation: 270 tests pass, ruff passes, strict mypy passes (2 files).
The 200-case acceptance gate covers 500 fake credentials and all survivors.

PR opened for review, not merged: https://github.com/RDW-Labz/remote/pull/2
CI passed at 2c8b3281fb68c0d5df99c299c94ca55fb7571214: https://github.com/RDW-Labz/remote/actions/runs/35657795263
Final UTF-8 guard review CLEAR. No further T03 live attempts were made.
