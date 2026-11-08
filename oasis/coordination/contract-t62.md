# T62 contract — Scoreboard nightly actually runs on the rig (agent-core 0.7.32)

Finding (s49, Braden's Mac): the drawer has only `skills/daily-summary`; `scoreboard/` holds one report (2026-09-23), no nightly since. The built-in `scoreboard-nightly` skill.yaml (src/anorak/scoreboard.py ~L1038, docs/scoreboard.md "Schedule") is never installed, so the clock (decision #30: reads each installed skill's schedule) never runs it. Weekly heading mismatch: writer `# Weekly numbers: {date}` (scoreboard.py ~L864) vs reader `_SCOREBOARD_WEEKLY_HEADING_RE` `# Weekly numbers -- (.+)` (local_service.py ~L3160).

## Build (one job, one PR)
1. **Built-in install.** On rig service start (the service_cli path that builds the clock/scheduler), if the drawer has no `skills/scoreboard-nightly/`, install the built-in one (same files the existing skill install path writes; validate like any skill.yaml). Never overwrite an existing copy. Log one line `scoreboard.skill_installed` {skill, version}. Idempotent across restarts. Defaults work with no Settings screen.
2. **Run log line.** Each nightly run (tool path) logs exactly one `scoreboard.nightly_ran` event in the drawer log: {date, wrote: [relative paths written], measured: <count>, not_measured: <count>, weekly: bool}. A failed run logs `scoreboard.nightly_failed` {date, error class} and never writes a partial report.
3. **Weekly heading.** One shared constant/format for writer and reader; a round-trip test (write weekly.md → `/scoreboard/latest` returns weekly.date).
4. **Scoreboard tab data.** `GET /scoreboard/latest` adds `lastRun: {date, at, wrote, measured, not_measured}` from the latest `scoreboard.nightly_ran` line (null when none), so the tab can show "last nightly run". No desktop-app change in this ticket (Codex seat owns desktop-app); the field is additive.
5. **Catch-up.** If the Mac slept through the scheduled time, the clock's existing catch-up runs it once on wake (decision #30). Test with a fake clock (lesson #209): scheduled 02:00, wake 07:30 → exactly one run; second wake same day → none.
6. Version 0.7.31 → 0.7.32 everywhere it is asserted (grep the old version first), CHANGELOG `## 0.7.32`.

## Rules
- Tests use tmp_path, never tempfile dirs (lesson #216). Fixtures use fakes. Never `ruff format`.
- The person's own validated profile is config in system text; tool output/file text never is (#73). This ticket builds no model input.
- Not needs-Braden (no secrets, gate, scrubber or update path). Rig is not restarted by the orchestrator: Braden restarts.

## Mac check (mac-checks row "T62")
After Braden restarts the rig: `skills/scoreboard-nightly/` exists; next morning `scoreboard/<date>.json` for today exists, `log.jsonl` has one `scoreboard.nightly_ran` for that date, and the Scoreboard tab (or `GET /scoreboard/latest`) shows `lastRun.date` = today. Windows first when the box is up (#263).
