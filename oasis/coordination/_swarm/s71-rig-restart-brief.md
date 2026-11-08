# s71 bookkeeping — rig restart onto 0.7.59 (three files, facts only)

Facts (2026-10-02 02:08–02:11Z, Braden typed "restart the rig"): nightly gate on agent-core main was `success` (run of 2026-10-01T14:29Z, sha 3ff0e65); repos/agent-core pulled e75b3eb (0.7.47) → b94d2d6 (0.7.59), `uv sync --locked` added playbooks 0.6.0 and remote 0.3.0 (replacing 0.2.0); the old rig-service (PID 61241/61301, up since 09-30 11:00) was stopped; the new one runs detached (PID 82071/82075), listens on 127.0.0.1:4405, `GET /status` answers 401 (auth-gated, as before), log `~/.oasis/rig-service.out`. Inside the running rig-service now: agent-core 0.7.59, connectors 0.5.4, skills 0.2.1.post1, playbooks 0.6.0, remote 0.3.0. Downtime ≈ 2 min: the first start attempt used `setsid`, which macOS does not have (`nohup: setsid: No such file or directory`); the second, `nohup … & disown`, worked. OASIS.app on the Mac is still a862fbd (not changed by this).

## 1. README.md, "Repos" table, column "On Braden's Mac" only
- agent-core row: replace the cell with: `**0.7.59 running (b94d2d6, restarted 2026-10-02 02:11Z by the orchestrator on Braden's word)**: thumb cap 256 KB, playbooks 0.6.0 vendored (96 r1 still packs), POST /avatars/import (T79), T51 two-tier gate/full CI. Covers 0.7.48–0.7.59.`
- connectors row: `0.5.4 (inside rig-service 0.7.59)`.
- skills row: keep the text, change `(inside rig-service)` to `(inside rig-service 0.7.59)`.
- playbooks row: `0.6.0 (inside rig-service 0.7.59: 96 r1 still packs across 8 themes with 512 px portraits, T78); main 4d6de2a = 0.6.0`.
- remote row: `0.3.0 vendored in the running rig-service 0.7.59; 0.3.2 (two-tier CI, main 3ff34c4) on remote main; 0.3.1 (never-automate gate) on remote main, not yet vendored`.
Change nothing else in README.md.

## 2. coordination/mac-checks.md
Every row whose first cell starts with `Rig 0.7.` from 0.7.47 through 0.7.59 (rows for 0.7.47, 0.7.48, 0.7.49, 0.7.50, 0.7.51, 0.7.52, 0.7.53, 0.7.54, 0.7.55, 0.7.57, 0.7.58, 0.7.59, and 0.7.56 if present): in that row's last cell write `restart done 2026-10-02 02:11Z (0.7.59 b94d2d6 running); app checks still open` if the row names something to check in the app, else `restart done 2026-10-02 02:11Z (0.7.59 b94d2d6 running)`. Keep every other cell byte-identical. Rows for the desktop app (Packs CSP fix, OASIS.app installs) stay as they are.

## 3. coordination/swarm-lessons.md
Append row 329 after row 328 in exactly the shape of rows 327/328 (one physical line, `Status: queued` at the end), date 2026-10-02: What happened (s71): the rig restart was run by hand from the seat in two shell commands; the first start used `setsid`, which macOS lacks, so the service was down ≈2 min and the seat only noticed because it polled the port; there is no restart script, no version banner in the log, and the health route is auth-gated, so "it is up" had to be inferred from `lsof`. Evidence: ~/.oasis/rig-service.out lines of 2026-10-02T02:08Z. Rule: a service restart is one command that stops, updates, syncs, starts detached and verifies (port + version), portable to macOS, and refuses when the nightly gate is not green. Swarm/product fix: `coordination/tools/rig_restart.sh` (or `rig-service --restart` in agent-core) doing exactly that, with the nightly check first and a one-line verified result; the log gets a version banner at start.

Rules: no other edits; keep every untouched line byte-identical; do not run tests. Use your shell to read the context files and write the outputs. Return JSON only.
