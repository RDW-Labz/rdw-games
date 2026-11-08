# UI pilot log (decision #93, details #96)

Brief: `coordination/ui-pilot-brief.md` (copied into each worktree as `.swarm-manifests/pilot-brief.md`, set as the manifest `contract`).

| Arm | Worktree / branch | Job | Model | Start | End | Rounds | Cost | Notes |
|---|---|---|---|---|---|---|---|---|
| A r1 | worktrees/desktop-app-pilot-a / t19-pilot-a | pa-build | codex gpt-6-astra (expensive) | 20:40 | 20:53 | 3 self-passes | 149.5k tokens, $0 (plan) | 12.3 min; envelope invalid → coordinator copied the kept worktree (lesson #64); 253/253 tests, WIP a5e1a3a |
| A dir1 | same | pd-critique-1 | claude opus (expensive) | 20:55 | 20:57 | — | $0.41 | revise, 9 fixes (worst: two rows selected, empty New chat threads in Recents); `.swarm-manifests/pilot-critique-1.md` |
| A r2 | same | pa-revise-1 | codex gpt-6-astra | 20:57 | 21:03 | 2 self-passes | 102.6k tokens | 5.8 min; fixed 8/9 (skipped mic wiring: out of scope); run marked failed again, copied by hand; 257/257; WIP 04a4494; shots `.pilot/a-r2/` |

Arm A total: 2 astra jobs (18.1 min, 252k tokens) + 1 opus director ($0.41, 2.1 min). Arm B: 1 sonnet job (21.3 min, $4.73) + 1 coordinator fix. Blind set sent 2026-09-24 as X/Y (key: `ui-pilot-blind-key.md`). Director round 2 not run (saved dispatches; r2 fixed 8/9).
| B | worktrees/desktop-app-pilot-b / t19-pilot-b | pb-build | sonnet (mid) | 20:40 | 21:01 | 1 | $4.73 | 21.3 min; typecheck + 1 test failed (default vs named import of ComingSoon) → coordinator 1-line fix; then 249/249. Removed the Pause button (a lost feature; needs a fix if B wins). WIP 8e008c3. Shots `.pilot/b-r1/`. |

Plan: A → coordinator captures shots (`.pilot/a-r1/`) → Opus director critique → Astra revise (≤2 rounds). B → coordinator integrates + captures shots. Braden picks blind (shots labelled X/Y). Neither merges until he picks.
# Blind key (do not show Braden before he picks)
X = arm B (sonnet, b-r1, 8e008c3)
Y = arm A (astra + opus director, a-r2, 04a4494)

**Result (Braden, 2026-09-24): Y — "much better". Y = arm A (Astra + Opus director). Decision #104.** Arm A ships as T19 part 1 (10/10 mutants killed). Arm B closed unmerged.
