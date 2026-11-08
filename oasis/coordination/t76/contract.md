# T76 build contract — agent-amber role file v1 + never-automate hosts (watcher deny + skills lint)

Sources: `docs/TICKETS.md` §T76 (line 608), decisions #328 #329 #330 (+ #73 #98 #142 #263 #323 for context),
root `AGENTS.md` hard rules, `repos/skills/docs/formats.md`, `coordination/references/amber-tools.md`
(**it exists now**, 32 lines, dated 2026-09-30 — company data, private repo only; cite it, never copy names
into a shared repo). Repo state read from `origin/main` of each repo (remote 56bd543 = 0.3.0, skills 6de8f92 =
0.7.1, agent-core f1ac0f8 = 0.7.52 with PR #91 = 0.7.53 open, connectors 0.5.4, agent-amber 5f85d1a = T01 only).
Fixed rule: the deny list is config in the role file, enforced by code (watcher + lint), never by the model; every
do action stays ask-first (#98); no company names in a shared skill or fixture.

## 0. Findings

- **profile.yaml has no deny-list field; the loader rejects unknown keys.** `anorak.memory._validation.Profile`
  (`repos/agent-core/src/anorak/memory/_validation.py:166-179`) has a closed `required`/`optional` set and raises
  `"Profile fields are invalid"` on any other key. `ProfileStore.load()` (`memory/profile.py:68-72`) pops exactly
  `avatar`, `theme`, `standing_rules`, `company_domains` before building `Profile`; `save()` (`profile.py:187-189`)
  re-attaches `standing_rules`/`company_domains` from disk so no agent write can add or widen them. **So:** a
  top-level `never_automate_hosts` key breaks every profile load until agent-core pops it → **job (d) is needed**,
  and formats.md must gain the field. formats.md line 3: "Change only with a decision" — #329 decides the list
  exists in the role file but not the field name/shape; that is an *extension of the fixed profile.yaml format*
  (same path #142 took for `standing_rules`), not a fourth format. `formatChangeNeeded: true` (§7 Q1).
  (Rejected: nesting under `preferences:` needs no agent-core change but is agent-facing (#73) and agent-writable.)
- **remote has no capture yet; the only "record" path is `TraceWriter.write`** (`src/remote/trace_writer.py:124-153`):
  scrub both halves, then append one JSON line. `docs/watcher.md` §4 defines per-site "Can I watch this page?"
  answers (`watch_answers` in profile) — watching starts only after a Yes. T05 capture (`proxy.py`) is unbuilt
  (watcher.md:56-60); "unseen: <host>" is the pinned-cert log line, unrelated. **Gate point = `TraceWriter.write`**,
  before `scrub_trace`, before any disk touch. `TraceWriterError`'s docstring (line 50): "never interpolate
  untrusted input" — the observed host comes from captured traffic, so the refusal string is fixed, hostless.
  remote depends only on PyYAML; it cannot import agent-core (agent-core vendors remote, `pyproject.toml:21,29`).
- **agent-core watcher seam:** `LocalService.record_watcher_event(kind, connected=)` (`local_service.py:2103-2125`)
  audits `state`/`watch_started`/`watch_stopped`/`macro_saved`; nothing in agent-core builds a `TraceWriter` yet
  (0.7.50 CHANGELOG). Wiring the profile list into a real writer is T05/T64-slice-4, **not T76**.
- **skills lint = `almanac.validate.validate_skill(path) -> list[str]`** (`src/almanac/validate.py:61-155`), one
  string per problem, CLI `python -m almanac.validate <skill.yaml>...` (158-169). It reads only `skill.yaml`.
  A skill folder is `SKILL.md` + `skill.yaml` + `fixtures/*.yaml` (no Python "skill code"). No shared skill names
  any host today (grep of `shared/` for `.com|.net|.org` is empty). `tests/test_validate.py:34-44` already asserts
  every `shared/**/skill.yaml` validates. Version 0.7.1; `agent-core>=0.7.22,<0.8` (range, per check-pins).
- **agent-amber** (`repos/agent-amber`): T01 template only — `src/art3mis/__init__.py` (`__version__ = "0.1.0"`),
  `tests/test_smoke.py`, `dependencies = []`, no `agent.yaml`/`profile.yaml`/`skills.yaml` although its
  `AGENTS.md` says pins live in `agent.yaml` and `playbooks/agent-template/{agent,skills}.yaml` define the shape
  (`agent.yaml`: `pins: {agent-core, skills, connectors}`, `model`, `proactive`). CI (origin/main) runs
  `uv sync --locked`, pytest, ruff, `mypy --strict src`, plus `swarm.mjs check-pins --core agent-core
  --app-prefix agent-` (project-swarm v1.25.0 `tools/check-pins.mjs`): an `agent-` repo may pin the core `==`, but
  each `==` pin must equal a `vendor/` wheel whose own requirements `uv.lock` satisfies — agent-core's wheel needs
  `connectors==0.5.4 playbooks==0.5.3 skills==0.2.1.post1 remote==0.3.0` (path wheels only; playbooks is 3.8 MB).

## 1. Jobs (one writer per file; build order d → b, c in parallel → a)

### (d) agent-core — `never_automate_hosts` survives profile load, never reaches the agent schema
Files: `src/anorak/memory/profile.py`, `tests/test_memory_profile.py`, `CHANGELOG.md`, `pyproject.toml` (version).
- `ProfileStore.load()`: add `data.pop("never_automate_hosts", None)` beside the four pops (`profile.py:68-71`).
- `ProfileStore.save()`: add `"never_automate_hosts"` to the preserve loop (`profile.py:187`) so an agent or
  onboarding save never drops or widens it (mirror of #142).
- New `ProfileStore.load_never_automate_hosts() -> tuple[str, ...]`: `read_raw()`, take the key (missing → `()`),
  validate with the §2 rule, raise `MemoryStoreError("Profile never_automate_hosts is invalid")` otherwise.
  Pure read; nothing calls it in agent-core yet (future T05/T64 wiring passes it to remote — §0).
- Not needed: `Profile` schema or system-instruction changes (list stays out of the agent schema), remote pin bump.

### (b) remote — watcher refuses to record a never-automate host (#329)
Files: new `src/remote/never_automate.py`, `src/remote/trace_writer.py`, new `tests/test_never_automate.py`,
`tests/test_trace_writer.py` (add cases), `docs/watcher.md` (one paragraph in §2 "Capture"/§4), `CHANGELOG.md`,
`pyproject.toml` (version).
- `never_automate.py`: `load_never_automate_hosts(value: object) -> tuple[str, ...]` (§2 rule; on failure raise
  `NeverAutomateError("never_automate_hosts must be a list of lowercase domain names")`, a fixed string);
  `class NeverAutomate` with `.hosts`, `.match(host: str) -> str | None` (returns the **listed entry** that matched —
  trusted config — or `None`; §2 match rule); `NeverAutomate.from_profile_yaml(path: Path)` = `yaml.safe_load` of
  the file (bounded: refuse > 262_144 bytes, non-mapping → same fixed error), then `load_never_automate_hosts(
  data.get("never_automate_hosts"))`. No logging of hosts inside this module.
- `TraceWriter.__init__(drawer_dir, session_id, *, never_automate: NeverAutomate | None = None)`; `None` →
  `NeverAutomate(())`. `TraceWriter.write`: after the two shape checks (lines 131-136) and **before** either
  `scrub_trace` call: `host = urlsplit(str(request.get("url", ""))).hostname`; if `host` and
  `self._never_automate.match(host)`: increment `self.refused` (new public counter, starts 0) and raise
  `TraceWriterError("never-automate host; not recorded")`. Nothing is written, `seq` does not advance. A URL with
  no hostname keeps today's behaviour (scrubber masks it, scrubber.py:289-296) — the deny gate never widens.
- `docs/watcher.md`: state that capture must construct `TraceWriter` with `NeverAutomate.from_profile_yaml(
  <drawer>/profile.yaml)` and that a refusal is reported to the service as the `watch_refused` event (§2) carrying
  the matched listed entry, never the observed URL. No change to `scrubber.py`, `macro.py`, `har_macro.py`.

### (c) skills — lint refuses a skill that names a never-automate host (#329)
Files: `src/almanac/validate.py`, `tests/test_validate.py`, `docs/formats.md` (profile.yaml block + lint rule 9 +
`--profile` in the CLI line), `CHANGELOG.md`, `pyproject.toml` (version).
- `validate_skill(path: Path, *, never_automate_hosts: Sequence[str] = ()) -> list[str]` (keyword-only; existing
  callers unchanged). Validate the list with the §2 rule first; invalid → return
  `[f"{path}: never_automate_hosts must be a list of lowercase domain names"]` and stop.
- Scan set = the skill folder (`path.parent`): `skill.yaml`, `SKILL.md`, every `fixtures/*.yaml`, read as UTF-8
  text (unreadable file → existing "cannot read" style error). For each file, lowercase the text, find host-like
  tokens with `[a-z0-9-]+(?:\.[a-z0-9-]+)+` and apply the §2 match rule against every listed entry; each hit appends
  `f"{file}: names a never-automate host '{entry}'"` (`file` = path relative to the skill folder; `entry` = the
  listed config value). Order: this scan runs after the existing reader/critic checks; both error sets are returned.
- CLI: `python -m almanac.validate [--profile PROFILE_YAML] <skill.yaml>...` — with `--profile`, `yaml.safe_load`
  the file (mapping required, else print the fixed error and exit 2) and pass its `never_automate_hosts` (missing →
  `()`). `almanac exit-test` unchanged (thin).
- `docs/formats.md`: add to the profile.yaml example `never_automate_hosts: [bank.example, payroll.example]  #
  admin-only; watcher + lint refuse these, code-enforced (#329)` and a paragraph mirroring `company_domains`'s:
  admin-only, never written by app/model, list of lowercase registrable domains, subdomains covered, watcher refuses
  to record, lint refuses a skill naming one, `watch_answers: yes` never overrides it. Lint rule 9: "No file in the
  skill folder names a host on the person's `never_automate_hosts` (passed by `--profile`)."

### (a) agent-amber — profile v1, pins, tests
Files: new `profile.yaml`, new `agent.yaml`, new `skills.yaml`, new `vendor/` (5 wheels + `provenance.json` +
`README.md`), `pyproject.toml`, `uv.lock`, `src/art3mis/__init__.py`, new `tests/test_profile.py`, new
`tests/test_pins.py`, `tests/test_smoke.py` (version), `README.md` (Status), `CHANGELOG.md`.
- `profile.yaml` (repo root, per `agent-template/README.md`; onboarding copies it into her drawer). Content — every
  line marked `[confirm]` is Braden's to check against amber-tools.md before merge:
  `name: Amber` · `title: COO, Cluer Holdings` · `reports_to: Michael` [confirm] · `access_level: admin` [confirm]
  · `ventures: [holdings]` [confirm; codes per #61] · `tools: [outlook, teams, onedrive, quickbooks, excel,
  acrobat]` — order = connector priority #328: outlook→`outlook` (live: read, send after Yes), teams→`teams` (read;
  send v2), onedrive→`onedrive` (catalog; Excel/PDF read), quickbooks→`quickbooks` (catalog, read-only); `excel`,
  `acrobat` are day tools with no connector (files via OneDrive; PDF read via pymupdf4llm). OneNote/To Do/Project
  are not listed: #328 maps them to daily note + proposals. `people: [{name: Michael, role: owner, how_often:
  daily}, {name: Braden, role: it, how_often: weekly}]` [confirm] · `day:` four lines from rows 7-9, 15 (Outlook/
  Teams triage; Excel trackers and P&Ls; Acrobat PDFs for outside parties; monthly utility share / freight invoices
  / month-end prep) · `preferences: {tone: short and direct [confirm],
  ask_before: [send email, send Teams message, pay anything, sign anything, post to QuickBooks], notes_and_tasks:
  "daily note + proposals"}` (#328: no new app) · `watch_answers: {}` · `company_domains: [cluerholdings.com]`
  [confirm] · `never_automate_hosts:` one registrable domain per row 10, 16-20 of amber-tools.md — Gusto, ATAP
  (`atap.arkansas.gov`), Keeper, Square (two domains: squareup + square), eBay, American Express, Stone Bank, Equity
  Bank, First Community Bank — **exact domains [confirm each]**; "others exist" → §7 Q2. QuickBooks read-only is a
  connector property (connector.yaml `can_do`), not a profile field — nothing to add.
- `agent.yaml`: `pins: {agent-core: 0.7.54, skills: 0.2.1.post1, connectors: 0.5.4}` (= what the Rig's
  `uv sync --offline --locked` installs, agent-core `pyproject.toml:17-21`; §7 Q4 on the skills number), `model`
  and `proactive` blocks copied from the template. `skills.yaml`: `shared: []`, `personal: []` (T76a-c add).
- `pyproject.toml`: `dependencies = ["agent-core==0.7.54"]`, `[tool.uv.sources] agent-core = {path =
  "vendor/agent_core-0.7.54-py3-none-any.whl"}` plus the four wheels agent-core's METADATA requires, copied from
  `repos/agent-core/vendor/` (connectors 0.5.4, playbooks 0.5.3, skills 0.2.1.post1, remote 0.3.0) with the same
  `[tool.uv.sources]` path entries; `provenance.json` per wheel in skills' shape (package, version, source, commit,
  wheel_sha256, build line). `uv lock`. Version `0.2.0`. This is the established vendored-wheel pin pattern; §7 Q5
  offers the thin alternative if 4.2 MB of wheels in a config repo is unwanted.

## 2. Cross-job names

| Name | Value | Defined | Used by |
|---|---|---|---|
| `never_automate_hosts` | top-level profile.yaml key, list of strings | formats.md (c) | (a)(b)(c)(d) |
| entry rule | lowercase; regex `^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`; no scheme/port/path/`*`; ≤ 200 entries; no duplicates | (b) `load_never_automate_hosts`, (c) same name, (d) `load_never_automate_hosts` | all |
| match rule | `h = host.lower().rstrip(".")`; hit iff `h == d` or `h.endswith("." + d)` for a listed `d`; IP literals never match; IDNA/punycode observed hosts match only literally (limitation, documented) | (b) `NeverAutomate.match`, (c) scan | (b)(c) |
| `"never-automate host; not recorded"` | `TraceWriterError` text, fixed, no host | (b) trace_writer.py | (b) |
| `"never_automate_hosts must be a list of lowercase domain names"` | list-shape refusal (remote `NeverAutomateError`; skills error string) | (b)(c) | (b)(c) |
| `"Profile never_automate_hosts is invalid"` | agent-core `MemoryStoreError` text | (d) | (d)(a) |
| `"{file}: names a never-automate host '{entry}'"` | lint refusal, `entry` = listed value | (c) | (c) |
| `watch_refused` | new watcher event kind for `record_watcher_event`; audit line `watcher refused: <entry>` — **defined here, wired later** (T05/T64-4), not built in T76 | (b) docs/watcher.md | future |
| `TraceWriter.refused` | int counter of refusals per session | (b) | (b) |
| `--profile` | `python -m almanac.validate --profile PROFILE_YAML …` | (c) | (c)(a, at T76a) |
| `bank.example`, `payroll.example`, `pos.example` | fake hosts for every shared-repo test/fixture | §3 | (b)(c)(d) |
| Amber's real domains | only in `repos/agent-amber/profile.yaml` (private repo) | (a) | (a) |

## 3. Tests per job (fake data only outside agent-amber)

- **(d)** `tests/test_memory_profile.py`: (1) a profile with `never_automate_hosts: [bank.example]` loads and
  `Profile.to_dict()` has no such key; (2) `load_never_automate_hosts()` → `("bank.example",)`; missing → `()`;
  (3) `["Bank.Example"]`, `["https://bank.example"]`, `"bank.example"` (string), 201 entries → `MemoryStoreError(
  "Profile never_automate_hosts is invalid")`; (4) `save(Profile)` on a file that has the key keeps it byte-equal.
- **(b)** `tests/test_never_automate.py`: shape rule table (valid/invalid as in (d)3 + duplicates + `*.bank.example`
  refused); match table: `bank.example`, `www.bank.example`, `BANK.EXAMPLE.` hit; `notbank.example`,
  `bank.example.evil`, `10.0.0.1` miss; `from_profile_yaml` on a tmp file, on a non-mapping, on a missing key.
  `tests/test_trace_writer.py` (+): writer built with `NeverAutomate(("bank.example",))`; an entry with URL
  `https://online.bank.example/login` and a planted `sk-FAKE-0000…` secret raises the fixed string, the file stays
  empty (0 bytes), `refused == 1`, the planted secret appears nowhere (file, exception text, caplog); a following
  `https://fake.example.test/` entry writes `seq: 1`. Existing tests unchanged (default empty list).
- **(c)** `tests/test_validate.py` (+): with `never_automate_hosts=["bank.example"]` every `shared/**/skill.yaml`
  still passes (extends `test_every_repo_skill_yaml_validates`); a tmp skill whose `do:` is
  `"connectors.email.search(from: alerts@online.bank.example)"` → exactly one error, the §2 lint string with
  `file == "skill.yaml"`; the same host only in `SKILL.md`, only in `fixtures/case-1.yaml`, and uppercase → each
  refused; `notbank.example` passes; invalid list → the fixed shape string; CLI `--profile` on a tmp profile
  containing the fake list → exit 1 with the string on stderr, and exit 0 with an empty list.
- **(a)** `tests/test_profile.py`: copy `profile.yaml` to `tmp_path/profile.yaml`, chmod 0600 (`read_private`
  needs a private file), `ProfileStore(path).load()` succeeds (proves formats.md/agent-core validation) and
  `load_never_automate_hosts()` returns a non-empty tuple equal to the YAML list; every `tools` entry is
  lowercase; `tools[:4] == ["outlook", "teams", "onedrive", "quickbooks"]` (#328 order).
  `tests/test_pins.py`: `agent.yaml` has the three pins, each matches `^\d+\.\d+\.\d+(\.post\d+)?$` (never
  `latest`), and `agent-core` equals the `==` pin in `pyproject.toml`. `test_smoke.py` version → `0.2.0`.

## 4. Mutants — one per gate (each must turn the named test red)

| Job | Mutant | Test that fails |
|---|---|---|
| (b) | delete the `match` check in `TraceWriter.write` (always record) | trace_writer refusal test (file no longer empty) |
| (b) | `match` returns `None` when `h.endswith("." + d)` (exact only) | `www.bank.example` hit row |
| (c) | delete the folder scan in `validate_skill` (return only reader/critic errors) | tmp-skill refusal test |
| (c) | scan `skill.yaml` only | "only in SKILL.md" / "only in fixtures" rows |
| (d) | remove the `never_automate_hosts` pop in `ProfileStore.load()` | (d)1 (load raises) and (a) profile test |
| (a) | change a `never_automate_hosts` entry to `Bank.Example` | `test_profile.py` (loader refuses) |

## 5. Version plan + CHANGELOG owner

| Repo | From → to | Why | CHANGELOG owner |
|---|---|---|---|
| agent-core | 0.7.53 (PR #91) → 0.7.54 | new `ProfileStore` method + pops; needs Braden (profile/ask-first adjacent) | (d) writer |
| remote | 0.3.0 → 0.4.0 | new public module + `TraceWriter` kwarg; **needs Braden** (touches the trace path) | (b) writer |
| skills | 0.7.1 → 0.8.0 | lint rule 9 + `--profile`; formats.md change; needs Braden (format) | (c) writer |
| agent-amber | 0.1.0 → 0.2.0 | first product content; **needs Braden** (T76 done-when) | (a) writer |

PR order: (d) first (its wheel feeds (a)); (b),(c) independent; (a) last. PR body: "needs Braden", checks, mutant log.

## 6. Checks — exact commands each job runs (paste output in the PR)

- all four: `uv sync --locked && uv run --no-sync pytest -q && uv run --no-sync ruff check . && uv run --no-sync mypy --strict src`
  (remote's CI uses `pytest -v --tb=short -o faulthandler_timeout=30 -o faulthandler_exit_on_timeout=true`; its 200-trace
  `test_no_leaks.py` gate is in that run and must stay green; agent-core's default `addopts` skips `native`).
- skills adds `uv run --no-sync python -m almanac.validate shared/*/skill.yaml`; agent-amber runs `uv lock` first and adds
  `node <project-swarm v1.25.0>/tools/swarm.mjs --root . check-pins --core agent-core --app-prefix agent-`.

## 7. Open questions for Braden (one line each; #159: build the stricter option, log provisional)

1. Is adding top-level `never_automate_hosts` to profile.yaml a format change needing its own DECISIONS row, or
   does #329 cover it? Provisional: log "#329a: field name/shape as §2", build as written.
2. "All banks": list-only (each bank domain Amber names, plus "others" as she names them; an unlisted site still
   needs her Yes before any watch — watcher.md §4) **[recommended, built here]** vs a code-maintained `@banks`
   category table in remote+skills (public domains, but two copies to keep aligned; no model either way)?
3. Exact registrable domains for the nine entries in §1(a), and whether Square needs both `square.com` and
   `squareup.com` — confirm against the real sites before merge.
4. `agent.yaml` `skills:` pin — the Rig installs `skills==0.2.1.post1` (agent-core vendor) while the lint lives in
   skills 0.8.0; pin the runtime number (as written) or the repo number?
5. agent-amber vendoring 5 wheels (4.2 MB, playbooks 3.8 MB) to run one real-validator test — keep (pattern of
   record) or use a thin schema test with `dependencies = []` and pins in `agent.yaml` only?
6. Should the list also block macro **replay** / `har_to_recording` of old traces, and does Keeper's "never read"
   need a connector-side field? Neither built here; record gate + no Keeper connector is v1.
7. T76a–c scope: each a `shared/` skill with company names as `profile`/argument values and fake fixtures, run
   through `--profile` lint in agent-amber's CI (needs a skills ≥ 0.8.0 wheel there — see Q4); confirm the order
   utility-share → freight-invoices-due → month-end-close-prep and that T76b is email-only (no TMS login).
