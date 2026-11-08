# Phase 0 tickets — Foundations

Work these in order. One PR per ticket. Each has a done-when that a test or a person can check. Full context is in `PLAN.md`, sections "Phase 0" and "Repos".

Phase 0 ends when Braden is user zero: the Rig installed on his Windows machine, Gmail connected with clicks only, one macro recorded and replayed, one skill run through the loop on two models, everything logged, Scoreboard producing its first nightly numbers.

---

## T01 — Repo template and CI (playbooks)

**Repo:** `playbooks`, then applied to all nine.
**Build:** A template folder with `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/`, `src/`, `tests/`, `.gitignore`, `.github/workflows/ci.yml`. Python repos get `pyproject.toml` (uv, pytest, ruff, mypy). `desktop-app` gets `package.json` + Tauri scaffold. CI runs tests, lint and types on every PR.
**Done when:** All nine repos exist under `Btabor11`, private, CI green on an empty test.

## T02 — Secrets interface (agent-core)

**Repo:** `agent-core`
**Build:** `src/anorak/secrets.py`: `get(name)`, `set(name, value)`, `delete(name)`, `list()` over the OS keychain (Windows Credential Manager, macOS Keychain) via `keyring`, behind one small interface so the Phase 3 vault (Keys) can replace the backend with no caller changes. Values never appear in logs, exception messages, `repr`, or test output. A `secrets` CLI for Braden to set a value without it echoing to the terminal.
**Tests:** Set, get, delete round-trip with a fake secret `sk-FAKE-0000`; a test that captures all stdout/stderr/log output during the suite and asserts the fake never appears; a test that a `KeyError` message does not contain the value.
**Done when:** All tests pass on Windows and macOS CI; ticket T03 can store client IDs through it.
**Why second:** T03 (registrations), T06 (macro replay) and T11 (connectors) all need a place to put a key before T09 would have built it.

## T03 — App registrations (connectors)

**Repo:** `connectors`
**Build:** `docs/registrations.md` with step-by-step for registering "OASIS" as an app in Microsoft Entra (delegated scopes: Mail.Read, Mail.Send, Calendars.ReadWrite, Files.Read.All, Sites.Read.All, Chat.Read, User.Read; admin consent flow) and Google Cloud (Gmail, Calendar, Drive scopes; OAuth consent screen; start restricted-scope verification; privacy policy page URL). Client IDs go into the secrets interface, never the repo. A script `scripts/check_registration.py` that confirms both apps respond to a token request.
**Done when:** Both client IDs stored in the keychain; Google verification submitted; check script passes.
**Note:** Start this on day one. Google verification can take weeks.

## T04 — Scrubber with leak tests (remote)

**Repo:** `remote`
**Build:** `src/remote/scrubber.py`. Input: a raw HTTP trace (method, URL, headers, body). Output: same trace with secrets masked as `••••••`. Masks: `Authorization`, `Cookie`, `Set-Cookie`, any header or field named like `key|token|secret|password|passwd|auth|session|csrf`, query-string values for those keys, and any string value with Shannon entropy above a threshold and length ≥ 16. Constants and short human values survive. Reports only a count of secrets removed, never the values. **Fails toward hiding**: when unsure, mask.
**Tests:** `tests/fixtures/traces/` with 200 synthetic traces across 20 fake services, each with planted fake secrets and a manifest of what must survive. `test_no_leaks.py` asserts zero planted secrets in output and all manifest constants present.
**Done when:** 0 leaks on 200 traces; a secret never appears in any log or stdout during tests.

## T05 — Local proxy on Windows (remote)

**Repo:** `remote`
**Build:** `src/remote/proxy.py` on top of `mitmproxy`. `remote learn "<task>"` starts it on `127.0.0.1:7788`, installs the local CA cert (Windows cert store, with a clear uninstall), sets the system proxy, and streams every request through the scrubber to a raw trace file. `remote stop` restores proxy settings and closes the trace. Handles apps that pin certificates by logging "unseen: <host>" instead of breaking them.
**Done when:** On a Windows test box, records Edge, Chrome and desktop Outlook traffic; restores settings cleanly on stop; unseen hosts listed, not broken.

## T06 — Macro format v1 and replay (remote)

**Repo:** `remote`
**Build:** `src/remote/macro.py`. Reads a scrubbed trace, groups calls by service, infers **constants** (same value every time) vs **arguments** (values that changed or look like IDs/names), writes `macros/<name>.remote` into the person's private drawer, never a git repo (macros hold client names and task data) (plain YAML: name, arguments, steps[], each step with request template, `ask_first: bool`, `rollback?`). `remote <name> <args>` replays it, pausing on `ask_first` steps. Tokens for replay come from the secrets interface, never from the trace.
**Done when:** One recorded two-service task replays with one changed argument and produces the same result; an `ask_first` step pauses and waits.

## T07 — Loop runner (agent-core)

**Repo:** `agent-core`
**Build:** `src/anorak/loop.py`. Takes a `skill.yaml` (goal, done_when, steps, checker, risky_steps, budget). Runs: plan → act one step → check (checker is a callable that is **not** the model: a test, a diff, a compare, or a second model with a different prompt) → fix from the failure text (max 3 per step) → done-when check → log. Budgets: max steps, max seconds, max spend; hitting one stops with a report. `risky_steps` pause and wait for a yes via a callback. Every turn appends a JSON line to the log: plan, action, check result, cost, actor, timestamp.
**Tests:** A fake tool and a real checker; a skill that must fail its checker twice then pass; a skill that hits its step budget; a risky step that waits.
**Done when:** All four tests pass; the log for each run is complete and replayable.

## T08 — Model switch (agent-core)

**Repo:** `agent-core`
**Build:** `src/anorak/models/` with one interface (`complete`, `stream`, `tools`) and adapters for Anthropic (Claude), OpenRouter, and Ollama. Model is chosen from config per agent and per skill, never in code. Cost per call is computed from a price table and logged. Spend alerts: cumulative spend crossing each $500 line triggers a notification hook.
**Done when:** The T07 test skill runs unchanged on two providers; cost appears in the log; the $500 hook fires in a test with a fake price table.

## T09 — Memory and network events (agent-core)

**Repo:** `agent-core`
**Build:** `src/anorak/memory/`: four stores in the person's drawer folder — `profile.yaml`, working memory (in-process, summarized to log at task end), append-only `log.jsonl`, and `notes/` (markdown, searchable with a simple local index). Secrets are already handled by T02; this ticket only calls that interface. Also emits **network events** (`node_created`, `link_used`, …) to `events.jsonl` for every skill run, connector use and drawer read — the shape is in PLAN.md "Network data model".
**Done when:** Profile survives a restart; working memory is summarized into the log at task end; events file has correct nodes and links after one skill run.

## T10 — Skill format, test runner, three starter skills (skills)

**Repo:** `skills`
**Build:** `docs/formats.md` defining `profile.yaml`, `skill.yaml`, `connector.yaml` (fields in PLAN.md "Phase 0 → Formats"). `src/almanac/runner.py`: loads a skill folder, runs its `test_cases` through the T07 loop with recorded fixtures, reports pass/fail. Three shared skills, each with `SKILL.md`, `skill.yaml`, 3 test cases: `daily-summary` (calendar + unread → short note), `file-filing` (move a downloaded file to the right folder by rules in the profile), `meeting-prep` (next meeting → one-page brief from notes and email).
**Done when:** All three pass 3/3 through the runner; a fourth skill with no test cases is refused by the runner.

## T11 — Connector catalog and Gmail/Outlook connect flows (connectors)

**Repo:** `connectors`
**Build:** `catalog/` with one `connector.yaml` per connector (Gmail, Outlook, Outlook Calendar, Google Calendar, OneDrive, Google Drive, Teams first). `src/gates/connect.py`: given a connector and a person, opens the provider's consent page in the system browser, receives the callback on `127.0.0.1`, stores the token via the secrets interface, tests the connection (one read call), refreshes on expiry. Emits plain-words step descriptions for the UI ("Click Allow on the screen that just opened") and plain-words errors ("Gmail said no. Try again or ask Braden.").
**Done when:** Braden connects Gmail and Outlook with clicks only; tokens in keychain; a `status` command shows both as Connected; a forced expiry refreshes silently.

## T12 — Thin Windows shell: the Rig (desktop-app)

**Repo:** `desktop-app`
**Build:** Tauri 2 app. "Thin" means exactly this list, nothing more: no onboarding polish, no Docs area, no Scoreboard tab, no Mac installer yet (Mac must still build). Sign in (company Microsoft account). Chat panel talking to the local `agent-core` service. Connect page with tiles reading from the T11 catalog and driving its flows. Activity log view reading `log.jsonl`. Pause button (stops the watcher and shows state). **Orb**: always-on-top small window, draggable, click opens the side panel, `Ctrl+Space` hotkey, glow state from a local API flag, right-click menu (pause, hide 1h, open app). Background service registered to start at login. Signed installer (`.msi`/`.exe`); auto-update from a GitHub release feed.
**Done when:** Installs on a clean Windows machine; orb appears above every window; Connect Gmail works end to end from the tile; the app updates itself from a test release.

## T13 — Onboarding script v1 (playbooks)

**Repo:** `playbooks`
**Build:** `onboarding/v1/`: the agent's self-introduction (what I am, what I watch, what I never do, how to pause me) in short screens; the question set (role, ventures, day, tools, people, preferences) with follow-ups; a writer that turns answers into `profile.yaml`; the "Can I watch this page?" first-visit prompt and its saved-answers store. Delivered as a skill so it runs through the loop.
**Done when:** Braden runs it as user zero in the Rig; his `profile.yaml` reads true to him; a second run skips answered questions and asks only the gaps.

## T14 — Scoreboard nightly skill v1 (agent-core)

**Repo:** `agent-core`
**Build:** `src/anorak/scoreboard.py` as a scheduled skill (`0 2 * * *`). Reads `log.jsonl` and `events.jsonl` for one agent and computes the ten measures in PLAN.md "Scoreboard": hours given back, tasks automated, proposals accepted, skill success rate, answers with sources, time to yes, ask-first friction, cost per task, plus the two weekly check-in values when present. Writes `scoreboard/YYYY-MM-DD.json` and a plain-words `scoreboard/weekly.md` every Monday. v1 only measures and reports; the tune-on-its-own actions (model switch, stop a rejected proposal) are Phase 1 tickets and must not be built here.
**Tests:** A fixture log of two weeks of synthetic runs with known answers; the ten numbers match; the weekly report names the skill with the lowest success rate.
**Done when:** Runs nightly on Braden's agent (user zero) and produces correct numbers from his real log; weekly report reads in plain words.

---

## After T14

`agent-amber` (Art3mis) is created from `playbooks/agent-template`. First Phase 1 tickets: Scoreboard tune-on-its-own actions, injection test suite for "do" tools, Zemeckis "Teach me this" button in the orb, personal-to-shared skill promotion flow.
