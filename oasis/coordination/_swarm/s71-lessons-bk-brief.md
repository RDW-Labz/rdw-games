# s71 bookkeeping — lessons table: shipped marks + rows 331, 332 (facts only)

## 1. Status marks in coordination/swarm-lessons.md
project-swarm 1.43.0 merged 2026-10-02 03:19Z (main 09da65c) carrying releases 1.40.0–1.43.0. In the rows with ids 293, 294, 295, 296, 297, 298, 299, 308, 322, 323, 324, 325, 326 replace the trailing `Status: queued` (or `Status: built …`) with `Status: shipped 1.43.0`. Keep every other character of those rows.

## 2. Append two rows after row 330, exactly in the shape of rows 327–330 (one physical line each, `Status: queued` at the end), date 2026-10-02
Row 331: What happened (s71): `ship` refused the 1.43.0 code PR with preflight `git-ignored-fixture` for 98 test references such as `tests/field-lesson-t81-cli.test.mjs -> .swarm/runs/run-0000/state.json`; none of those paths exist in the repository — the tests create them under their own temp root at run time; the seat re-ran with seven `--exempt 'git-ignored-fixture:<test>=…'` flags (worktrees/swarm-code-pr-ship.log, ship2.log). Rule: a preflight flags a fixture only when the referenced path exists in the working tree and is git-ignored; a path that does not exist is a runtime path, not a fixture. Swarm fix: the `git-ignored-fixture` guard checks existence before the ignore test (shipping in 1.44.0, batch AB item 4).
Row 332: What happened (s71): a DeepSeek payload job was given `maxOutputTokens: 6000` by hand and died with `finish_reason length` after 29 s (run 1790903187723-eeb04c06); the same job with the model default (16000, lesson 226) completed. Rule: never set a single-request job's output cap below the model's default; a reasoning model spends part of the budget on its own thinking. Swarm fix: `validate` warns `max-output-below-model-default` naming both numbers (shipping in 1.44.0, batch AB item 5).

Rules: no other edits; keep every untouched line byte-identical; do not run tests. Use your shell to read the context file and write the output. Return JSON only.
