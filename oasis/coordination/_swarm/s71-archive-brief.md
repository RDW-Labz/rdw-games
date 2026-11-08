# s71 — archive the old history out of TASK.md and HANDOFF.md (TASK.md "Later" item; speed item 6)

Both files are a stack of dated blocks; each block starts with a line beginning `# ` and runs to the next `---` separator line. Newest block first.

1. coordination/TASK.md: keep the first THREE blocks exactly as they are (the 2026-10-02 03:45Z night block, the 2026-10-02 00:50Z block, and the 2026-10-02 00:30Z "session 70 → session 71" block that carries the **Rules in force**). Move every block after them, byte-identical, into a new file coordination/archive/TASK-history-to-2026-10-02.md, under a first line `# TASK.md history archived 2026-10-02 (blocks older than session 71); the live file keeps the three newest blocks`. In TASK.md, where the moved blocks were, leave one line: `_Older blocks (sessions ≤ 70) are in coordination/archive/TASK-history-to-2026-10-02.md._`
2. coordination/HANDOFF.md: keep the first TWO blocks (the Session 71 block and the Session 70 FINAL handoff block). Move the rest, byte-identical, into coordination/archive/HANDOFF-history-to-2026-10-02.md with the same kind of first line, and leave the same kind of one-line pointer in HANDOFF.md.
3. Nothing else changes; no reflow, no re-wrapping; the moved text is byte-identical to what was removed (the orchestrator will diff-check: old file == kept part + pointer, archive == removed part).

Use your shell to read the context files and write the four outputs; do not run tests. Return JSON only.
