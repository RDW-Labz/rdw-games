# T05/T06 parallel contract

Braden authorized both now, separate files, one PR each, no merge. T02/T04 merged;
agent-core main 88e382c and remote main d3375fb pulled. No Windows test box exists:
T05 Windows app acceptance must remain explicitly UNVERIFIED, never claimed from
CI/fakes. T03 untouched, no secret reads or provider probes. Root nine rules and
remote AGENTS apply. Python3.12, uv lock, pytest/ruff/strict mypy. No real secrets,
no changes to developer's proxy/cert/keychain, no employee terminal requirements.
Project-swarm preflight passed but launch failed required CLI isolation flags;
use native workers with exact ownership, don't weaken external safety settings.

## Worktrees and owners
T05 owner: worktrees/remote-t05 only, src/remote/proxy.py, proxy_windows.py,
proxy_cli.py, proxy_addon.py, tests/test_proxy.py, test_proxy_windows.py,
test_proxy_addon.py, docs/proxy.md. May add another proxy_-prefixed module/test
only after notifying root. No editing scrubber or corpus.
T06 owner: worktrees/remote-t06 only, src/remote/macro.py, macro_cli.py,
macro_transport.py, tests/test_macro.py, test_macro_cli.py,
test_macro_transport.py, docs/macros.md. May add another macro_-prefixed module/test
only after notifying root. Never write .remote files inside any git repo, even
synthetic ones; tests generate them in a private temp directory outside a repo.
Root owns both worktrees' packaging, locks, CI, README/CHANGELOG/.gitignore,
src/remote/cli.py, tests/test_cli.py, and independent cross-component checks.
Workers never git switch/add/commit/push, or modify the other worktree. Shared
packaging/CLI is root-controlled; no concurrent writers. Both PRs base main.

## Shared boundaries (do not silently change)
Trace stream: UTF-8 JSONL, one ordinary dict per line with exactly method:str,
url:str, headers:list[list[str]] (duplicate-preserving name/value pairs), body:
str|dict|list|None. No raw mitmproxy dump, response body, credentials, task text or
exception text in a log. A request dict passes T04 scrub_trace immediately before
append, not at some earlier assumed boundary. Unicode/parse/unsupported bodies
fail closed. Trace body may be opaque MASK; T06 must refuse replay when any MASK
remains unresolved, not send literal masks. Bounds/limits/failure are fixed messages.
T05 TraceWriter(path).write_request(trace) -> None opens private trace and appends
only scrubbed dicts. close() closes. Expose enough to root's controlled integration.
T06 load_recording(path)->list[dict[str,object]] reads that JSONL with bounds;
infer_macro(name, recordings: list[list[dict[str,object]]])->dict[str,object];
save_macro(macro, drawer:Path)->Path; load_macro(name,drawer)->dict[str,object].
Compiler groups by fixed HTTP(S) origin but preserves original step order.
Multiple recordings align same method/service/path shape positions; disagreeing
shapes fail loudly, no guessing. Constants shared across samples stay literal;
changed values or likely ID/name fields become named arguments. Single sample
heuristics conservative/documented; no LLM. name/arguments/steps[] YAML format as
T06 ticket, steps.request template, ask_first: bool (default true for every
inferred step), optional rollback preserved but never autoexecuted. No fourth
user config schema. Secret references are allowed only explicitly in request
header values via {'secret': 'validated.keychain.name', 'prefix': 'Bearer '};
no stored token values, automatic host guessing, or plaintext secrets in arguments.
Compiler must strip/replace scrubbed auth headers only with explicit binding
configuration; unresolved MASK anywhere fails replay. No replacement sentinel
may be used as a real credential.
Replay uses callback confirm(step_index, sanitized_step_summary)->bool; absent,
EOF/no/exception pauses/stops BEFORE any network or secret resolution. File flag
enforced mechanically; untrusted response can never change steps/gates. Call
status paused/complete/failed explicit. `replay_macro(macro, arguments, *,
transport, secret_reader, confirm, audit)` API may use dataclasses/protocols;
worker publishes exact signature early. Tokens come only via injected T02 reader
.get(name).reveal() at send boundary; default reader dynamically imports
anorak.secrets and requires installed agent-core exactly0.2.0. Root documents local
sibling install, no invented public PyPI package. No live keychain calls in tests.
Only fixed origins from saved template; args cannot alter host/scheme/port/userinfo,
method, headers names or secret refs. Percent-safe URL substitutions, structurally
safe JSON/form templates; no recursive template expansion. No redirects/token
forwarding, no automatic retries of mutation, bounded response/time, TLS verification
on. Loopback HTTP is allowed for controlled acceptance; arbitrary plaintextremote
HTTP with auth is refused. HTTP error status fails, errors don't echo body/URL/args.
Every action append-only metadata audit (actor,what,data identifiers only hashes or
step index,model=None,when,cost=0,outcome). Audit-start failure prevents action;
outcome failure reports uncertainty, no blind retry. Reports never include tokens,
request/response bodies, exception text or argument values. Macro files can contain
company task data so private drawer only; reject git ancestry/symlinks/traversal,
use restrictive dirs/files, atomic no-clobber save. No private .remote file in repo.

## CLI adapter and packaging
Root creates identical lazy router `remote.cli:main` in both PRs. T05 module
proxy_cli.main(argv:list[str])->int receives learn/stop/uninstall-ca commands.
T06 module macro_cli.main(argv:list[str])->int receives all other argv. It handles
`remote macro build NAME TRACE [TRACE...]`, `remote NAME key=value ...` (non-secret
arguments only), and help. Macro build handles unresolved auth binding through
explicit --secret HEADER=STORE.NAME options plus optional safe prefix; never value.
No print of trace/task contents/raw argparse value errors. Workers own moduleCLI
with callable main, root owns the command entry/router. Missing other optional
module gives generic unavailable command, not traceback. No future ticket behavior.
Dependencies root pins after research. T05 mitmproxy. T06 PyYAML for safe_load/dump
plus exact version pin; reject YAML aliases/duplicate keys/arbitrary tags and size
limits. Types via stubs/dev deps only as needed. Workers communicate dependencies.

## T05 specifics
Windows only system changes, WinINET current-user proxy snapshot and exact restore
(including absent values), notify settings refresh. No global WinHTTP/admin changes.
Per-user OASIS CA, trust only owned cert, clear uninstall of exact fingerprint;
never delete pre-existing trust owned by someone else. Snapshot durable BEFORE
change; rollback partial start/stop failures; idempotent stop; stale recovery and
concurrent learn refused. Keep runtime private outside git. Background learn and
separate stop must work, authenticated/owned local stop mechanism (never PID-only
kill or process-name sweep). Bind only127.0.0.1:7788, verify listener ready before
proxy redirect. No stdout/stderr/http-event logs containing raw mitmproxy traffic;
no dump/hardcoded flow save. Call T04 on every disk-bound request. File/auditfailure
must stopcapture and restore proxy, never rawfallback. Audit and traces separate.
Cert pinning: never disable TLS verification or modify applications. Pre-excluded
hosts pass through and report scrubbed `unseen: <host>`. Unknown handshakefailure
cannot guarantee the firstconnection; flag honest limitation and don't assert
zero app impact. Research agent will supply official API details; defer unapproved
tradeoff, but implement testable safe known-host passthrough. Apps bypassing proxy
cannot be detected from no traffic alone; do not invent seen/unseen evidence.

## Checks and stop
Worker tests before/with code; tests use obvious sk-FAKE values, injected Windows
APIs/keychain/transport and private temp state. Root will install pinned deps and
run all tests incl T04 200-trace gate, lint and stricttypes in eachworktree. Bind
acceptance tests to existing pytest; root creates controlled two-service replay
and combined T05writer->T06compiler->replay integration. Real Windows app evidence
is unavailable and must remain open. No CA/proxy changes on this Mac. Stop affected
work on unclear shared interface, real secret need, design beyond plan, or third
same failure. Reviewer returns READY/FIX/BLOCKED before dispatch. No merges.

## Dispatch amendment (supersedes corresponding earlier T05 notes)
T05 uses an in-memory session CA; no private-key serialization to disk or keychain
needed. Generate it in process, keep TLS key objects memory-only; export only
public cert. Install owned public CA per session, remove on stop/cleanup. Record
only public certificate fingerprint/ownership for crash recovery. Replace
mitmproxy default TLSConfig cert-store creation so no default private PEM/P12 is
written; pinned real-dependency smoke test must prove this. Pin mitmproxy12.2.3.
CLI learn can run foreground until remote stop/Ctrl-C; do not invent detached
supervisor. Separate stop command uses owner-only private stop-request/state files,
never arbitrary PID kill. Secret-free session identifiers and restrictive private
runtime directory (Windows current-user ACL inherited) are sufficient. Restore
onfinally; stale snapshot available to next stop; don't claim kill-9 can executefinally.
First-visit gate is mandatory: consent callback returning yes/no/not_now with
unanswered default no capture/interception. Persist only per-site yes/no answers
privately; not_now asks on next visit. No global always answer. CLI can use an
operator prompt; callback is futureUI seam, not onboarding implementation.
Before consent TLS passes through; no request body capture. Full capture only
known consenting hosts. Unknown-pinning tradeoff is awaiting Braden's explicit
answer: isolate policy seam and tests, don't assume approved degraded acceptance.
Known excluded hosts pass through untouched. No Windows box per Braden; T05draft.
Official sources: mitmproxy v12.2.3 tools/dump.py, master.py, addons/tlsconfig.py,
certs.py, examples/contrib/tls_passthrough.py; Microsoft certutil, WinINET
per-connection options docs. Source research supplied by t05_research agent.

## Manager corrections for dispatch
Secret bindings are step-scoped ONLY: `--secret STEP:HEADER=STORE.NAME` (1-based
step index), optional prefix only from explicit safe binding metadata. Reject
ambiguous/global bindings. Never reuse one service's binding for another origin.
T06 v1 accepts only ask_first:true on every step: no injection-suite eligibility
exists in Phase0, so false flags are rejected, never silently trusted. This is
mechanical validation of file policy, not model judgment. Later skill eligibility
support belongs later. Explicit rollback stays gated and is never automatic.
T05 holds an OS-backed exclusive session lock through completed restore/cleanup.
Use filelock==3.20.3 plus serialized state/recovery operations; active stop only
requests the owning session to stop and waits, never restores under a live owner.
Stale recovery acquires exclusive ownership before restoring any saved settings.
No new learn while recovery incomplete. Marker bound to session ID; no PID killing.

Braden chose recommended policy: tested-compatible-host allowlist plus per-site consent, unknown hosts pass through unseen with no deliberate first-failure discovery. Decision31. NoWindowsboxyet.
