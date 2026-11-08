# Usage ledger

| Date | Task | Worker | Model | Result | Rough cost |
|---|---|---|---|---|---|
| 2026-10-15 | REV P0: tool smoke (CODEX_OK) | Codex CLI | default | pass | $0 (subscription, ~10k tokens) |
| 2026-10-15 | REV P0: tool smoke (CURSOR_OK) | Cursor CLI | composer-2.5 | pass | $0 (team plan) |
| 2026-10-15 | REV P0: tool smoke via swarm | Hermes (swarm) | qwen3.8-35b-a3b | FAIL (Malformed CLI JSONL) | $0 |
| 2026-10-15 | REV P0: tool smoke direct | Hermes (ssh) | qwen3.8-35b-a3b | pass | $0 |
| 2026-10-15 | REV P0: 6 prod read-only queries + audit + baseline | Claude (orchestrator) | opus-5.5 | pass | subscription |

Daily summary 2026-10-15 — Hermes: 2 calls ($0) · Cursor: 1 ($0) · Codex: 1 ($0) · OpenRouter: 0 ($0) · Claude: orchestrator only.
| 2026-10-15 | REV P1: market research (10 searches, 7 fetches) + segment query | Claude (orchestrator) | opus-5.5 | pass | subscription |
| 2026-10-15 | REV P2: rubric, 17 candidates, scoring (gate FAILED, top 69) | Claude (orchestrator) | opus-5.5 | fail (gate) | subscription |
| 2026-10-15 | REV P2c: refunds-before-pickup breakdown (2 prod queries) + reason proposal + issue #519 | Claude (orchestrator) | opus-5.5 | pass | subscription |

| 2026-11-04 | Builder/orchestrator daily total (`~/.bingo-autopilot-spend.json`) | OpenRouter (`opencode`) | deepseek/deepseek-v4.1-flash-1017 | ran | $13.701847 of the $50/day cap; self-improvement share not itemized (unknown) |
| 2026-11-04 | Cap history | — | — | — | $5 → $10 (Nov 3) → $50 (Nov 4, Braden); live `run.sh`/`tick.sh` enforce $50 |

Daily summary 2026-11-04 — OpenRouter/autopilot: $13.701847 of $50 (27.4%). Source is the local autopilot spend file, not a vendor invoice; the self-improvement share is unknown because entries are not tagged by task. This is the first real builder-spend line since 2026-10-15.

| 2026-11-05 | Builder/orchestrator daily spend | OpenRouter/autopilot | — | source missing | No Nov 5 local spend file survives: `~/.bingo-autopilot-spend.json` was overwritten for 2026-11-06 (now `$0.590040`). Nov 5 is **not reconstructed**; the self-improvement share is unknown because entries are not tagged by task. |
| 2026-11-06 | Cap change (owner, Nov 5 2:27 PM CT via Grok) | — | — | — | Combined **warn $200/day, hard stop $300/day**; fixed machine shares ghost **$100/day**, mac-mini **$200/day** (#831). Master `run.sh`/`tick.sh` still enforce $50 until the #831 launcher merge. |

Daily summary 2026-11-05 — OpenRouter/autopilot: **unavailable** (no surviving local spend file; deliberately not estimated). Combined caps now warn $200 / hard $300; shares ghost $100 / mac-mini $200. Self-improvement share unknown.

Daily summary 2026-11-06 (partial) — OpenRouter/autopilot: $0.590040 recorded in `~/.bingo-autopilot-spend.json` at 2026-11-06T01:34Z; self-improvement share unknown.
