# s71 bookkeeping — T83 ticket entry + lesson 330 (facts only)

## 1. docs/TICKETS.md
After the `### T79 — Pack import route …` entry (the last `###` entry before `## T80`), add one entry in the same style as T62–T79 (a `###` heading, then **Repo:**, **Bug:**, **Fix:**, **Tests:**, **Done when:**, **Status:** lines in plain words):

`### T83 — Orb renders a tiny 3×1.5 slice of an animated-tier pack sheet (desktop-app) — Braden 2026-10-02`
- Repo: desktop-app.
- Bug: with the Pets pack `pets-01` (tier animated, 12 columns × 12 rows of 128 px frames, 1536×1536 sheet) in use, the orb showed three full figures and half a second row, all tiny, instead of one frame; standard 4-column packs were fine. Cause: the orb stylesheet fixed the sheet's background-size at 512px 1024px (four columns, eight rows). Evidence: coordination/references/bugs/t83-orb-pets-01-sheet-2026-10-02.png.
- Fix: columns, rows, frame size and frame count come from the pack manifest (grid.columns, grid.rows, grid.frame, frames, fps); a manifest without frames keeps four frames at the old rate.
- Tests: 12-column animated manifest sizes to 1200% × 1200% and the working state starts at column 0, row 1; the 4-column standard manifest pins today's values; a manifest without frames falls back to 4; the orb never shows more than one frame; the orbStyles pin follows the new rule. Mutants m1–m3 (hard-code columns to 4; use frames for the row count; drop the missing-frames fallback) all killed.
- Done when: the orb shows one frame of pets-01 on Braden's Mac after the rebuilt app is installed.
- Status: shipped to CI 2026-10-02 (branch t83-orb-animated-sheet-pr d5fe1a6); app rebuild and install follow the merge.

Change nothing else in the file.

## 2. coordination/swarm-lessons.md
Append row 330 after row 329, in exactly the shape of rows 327–329 (one physical line, `Status: queued` at the end), date 2026-10-02: What happened (s71): `npm run lint` (`eslint .`) on a desktop-app build tree reported 9 errors, all in `.swarm/runs/<id>/worktrees/<job>/…` copies of test files that a running mutants-file job had checked out inside the repo root; the seat had to read the file list to see that none of the 9 was in a changed file. Rule: a swarm run's working copies never sit where the project's own tools scan; a check that reports a file under `.swarm/` is the swarm's fault, not the ticket's. Swarm fix: the codex/claude-shell adapters create job worktrees outside the repo root (the per-job scratch dir from lesson 299) or `run` writes `.swarm/.eslintignore`-equivalents is not enough — place them outside; and `ship`/`integrate` check output strips lines whose path starts with `.swarm/` and warns `check-hit-swarm-dir` instead of failing on them.

Rules: no other edits; keep every untouched line byte-identical; do not run tests. Use your shell to read the context files and write the outputs. Return JSON only.
