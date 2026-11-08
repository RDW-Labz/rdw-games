87. **A scratch file committed into a release surfaced only a branch
    later.** A short-lived scratch document, never meant to be tracked, rode
    into a commit and was noticed only once a later, stacked branch showed
    it as modified. Rule: a change that adds a scratch-shaped file never
    enters a commit unmerged. Enforcement: pushing a reviewed change now
    refuses when its diff adds a file matching a small set of known scratch
    patterns, naming the offending path, unless an explicit, reasoned
    exemption names that exact file. Regression coverage is in
    `tests/ship-125.test.mjs`.
88. **A failing check that was new to the change was excused as
    pre-existing, and merged.** A guard meant to tell a flake apart from a
    real regression compared only exit codes, not which test actually
    failed, so two tests that existed only in the change being shipped were
    waved through as if they already failed before it; the same failure
    also happened only because a resolved tool directory was missing from
    the check's own environment. Rule: a failing test is pre-existing only
    when that same test, by id, already failed on the unchanged base; a
    test absent from the base is never pre-existing, and a check's own
    resolved toolchain must reach every process it spawns. Enforcement:
    every failing check now records a per-test status of fail, pass, absent
    or unknown against a base run, and only a genuine base failure is
    treated as pre-existing; every spawned check inherits the same resolved
    toolchain location. Regression coverage is in `tests/ship-125.test.mjs`
    and `tests/wire-125.test.mjs`.
89. **A test suite wrote real fixture rows into a live audit log.** Running
    the test suite left fixture organization names and fixture reasons
    sitting in the genuine, on-disk audit log a real release would read.
    Rule: tests never write under the real install location. Enforcement:
    the audit log's own path is now overridable by an environment variable
    that every test sets to a temporary directory, with a test asserting
    the real log stays untouched after the suite runs. Regression coverage
    is in `tests/ship-125.test.mjs`.
90. **A release step had no `--help`, and an externally built run's own
    identity was unrecoverable.** A release command failed outright on
    `--help`, and, separately, a run built outside the normal flow left no
    way to name which run had produced a given branch, costing a manual
    source read to piece it back together. Rule: every command answers
    `--help`, and every result names the run (or the branch) that produced
    it. Enforcement: `--help`/`-h` now prints usage and exits cleanly before
    any other flag is parsed, and every release result carries its own run
    or branch identifier. Regression coverage is in `tests/ship-125.test.mjs`
    and `tests/wire-125.test.mjs`.
91. **A read-only research job's reply could not be trusted to hold JSON at
    all.** A research call to a plain API model expected a final line of
    JSON, but the model's real reply was ordinary prose, so the exchange
    returned only a hard parse error instead of anything usable. Rule: a
    read-only reply that fails to parse as the requested JSON still returns
    a usable answer, marked as such, rather than nothing at all.
    Enforcement: when no parsable JSON line is found, the reply now falls
    back to the model's own summary text with an explicit "not parsed as
    JSON" flag alongside it. Regression coverage is in
    `tests/ask-125.test.mjs`.
92. **Two runs started in the same instant were given the same id.** Two
    background jobs launched within the same millisecond generated
    identical run identifiers, so the second one collided with the first
    and died before it ever started; a cancelled job also reported no idea
    what it had already spent. Rule: a run id is unique across processes,
    not merely across milliseconds, and a cancelled job still reports
    whatever it is known to have spent. Enforcement: run ids now add a
    short random suffix and retry once on a genuine collision; a cancelled
    job reports its last known cost, or an explicit "unknown" flag with the
    amount it had reserved when no cost was ever observed. Regression
    coverage is in `tests/scout-125.test.mjs` and `tests/ask-125.test.mjs`.
93. **A research gate rejected results a brief had explicitly allowed.** A
    license check used only its own fixed, hard-coded allowlist, so
    worker-verified results the requesting brief explicitly permitted were
    moved to rejected anyway, and had to be re-admitted by hand. Rule: a
    gate driven by policy reads that policy from the request that actually
    made it, not only from a list baked into the tool. Enforcement: the
    gate now reads an explicit allowed-licenses line from the brief itself
    when present, falling back to the fixed list only when the brief names
    none. Regression coverage is in `tests/scout-125.test.mjs`.
94. **A gate that moved a result also quietly dropped what was known about
    it.** A licensing gate relocated a result to a rejected list but kept
    only its name and link, discarding every other fact — license
    evidence, version pin, compatible ranges — that had already been
    verified about it. Rule: a gate may move a result, but it must never
    drop the facts already gathered about it. Enforcement: a rejected
    result now keeps every field the original result carried, plus which
    gate moved it and why. Regression coverage is in
    `tests/wire-125.test.mjs`.
95. **A worker's required inputs sat untracked next to files it was actually
    given, and there was no way to say a job could delete something.** A
    job's own directory held extra, untracked files the job needed but was
    never handed, and separately, a worker whose task genuinely required
    removing a file had no way to say so, since the standard instruction
    flatly forbade deletion. Rule: a directory that holds untracked
    siblings to what a job was given is worth flagging, and a job that must
    delete something says exactly what, in the open. Enforcement:
    validation now warns when a context file's own directory holds
    untracked files never named to the job, and a job can now declare
    exactly which paths it may remove; only a path declared this way is
    ever actually deleted, and removing anything else is refused by name.
    Regression coverage is in `tests/wire-125.test.mjs`.
96. **The same timing-sensitive tests flaked only under real parallel
    load.** Two tests that waited on fixed, wall-clock sleeps passed alone
    but intermittently failed when several processes ran the same suite at
    once, making a real regression indistinguishable from ordinary system
    noise. Rule: a timing-sensitive test waits on the actual event it
    needs, never on a fixed sleep. Enforcement: both tests were rewritten to
    wait on their own completion signal instead of a clock, and now pass
    reliably under repeated parallel runs. Regression coverage is in
    `tests/swarm.test.mjs`, `tests/cli-adapters.test.mjs`, and
    `tests/lessons120-mutants.test.mjs`.
97. **A stale internal version pin was found three times before anyone
    built a check for it.** The same kind of mistake — a library pinning an
    internal dependency to one exact version instead of a range, or an
    exact pin left behind after a vendored copy moved on — recurred across
    unrelated projects, discovered only once each at a fresh, offline
    install. Rule: check what a project actually ships against what it
    actually pins, before a stale pin ever reaches an offline install.
    Enforcement: a new check reads each project's own dependency
    declaration, lock information, and vendored copies, and reports every
    exact-pin mismatch it finds, exiting non-zero on any finding.
    Regression coverage is in `tests/check-pins.test.mjs`.
98. **A name that must never appear in a public repo had no automated guard
    against it.** A term internal reviewers all knew to keep out of a public
    project's history relied entirely on every contributor remembering not
    to type it, with nothing to catch a slip before it was pushed. Rule: a
    name that must never reach a public diff is checked by a tool, not by
    memory alone. Enforcement: shipping now reads an optional list of such
    terms and refuses, before pushing, when any line the diff actually adds
    contains one — naming the file and line, never the text itself — but
    only against a repo actually reported public; a private or internal
    repo, or a project with no such list, ships as before (the result
    records that no list was found; it is not a warning). Regression coverage is in
    `tests/private-names-125.test.mjs`.
