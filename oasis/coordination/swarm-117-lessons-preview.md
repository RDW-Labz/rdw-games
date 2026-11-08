# swarm 1.17.0 — new public docs/lessons.md entries (for Braden's OK before push)

21. **A toolchain path had days left before macOS deleted it.** A named tool
    path and a check's own argv binary both resolved under a temp directory
    that macOS silently clears after a few days unread. Rule: warn as soon as
    a resolved binary lives under a temp directory unsafe to leave unattended.
    Enforcement: `doctor` warns when a named tool path, or a check argv
    binary, resolves under `/tmp` or `/private/tmp`, naming the macOS
    three-day cleanup and telling the operator to move the toolchain.
    Documentation: [manifest reference](manifest-reference.md#doctor).
22. **A pinning test could never actually run against the file it pinned.**
    A job's declared outputs included a file whose own regression tests
    needed a shell, but the worker assigned to write it had none, so nobody
    could ever exercise that pin. Rule: flag an output whose only tests a
    no-shell worker cannot run when that output is also the runner's own
    core module, and suggest a follow-up checker job instead of trusting an
    unverifiable pin. Enforcement: `validate` warns to "consider a checker
    job" in that exact situation; `inspect` also reports cost per 1k output
    tokens per job whenever token usage is known, making a token-heavy job
    visible without hand computation. Documentation: [manifest
    reference](manifest-reference.md#validate).
23. **A dependency lockfile changed and nobody resynced the environment.**
    An integrated run touched a lockfile, and the checks that followed ran
    against an environment nobody had reinstalled into, giving misleading
    results. Rule: let a manifest declare commands to run before checks
    whenever a lockfile changed, and warn plainly when it doesn't.
    Enforcement: `integrate` runs an optional manifest `preChecks` (an argv
    array) before its checks whenever an integrated file matches a lockfile
    pattern (`uv.lock`, `package-lock.json`, `Cargo.lock`, `pnpm-lock.yaml`);
    with a changed lockfile and no `preChecks` declared, it warns "lockfile
    changed, env not synced". Documentation: [manifest
    reference](manifest-reference.md#prechecks).
24. **A failed check's real assertion was buried in a full log.**
    Diagnosing a failed run meant opening a whole log file to find the one
    assertion that actually failed, every time. Rule: surface the failing
    assertion inline, and let a diagnostic job see actual measured failures
    instead of a paraphrase. Enforcement: `integrate` prints a compact
    `failures` array (check name plus its last failing assertion lines,
    capped) for every failed check; `validate`/`run` accept `--evidence
    <file>`, whose failures block is appended verbatim to every job prompt
    under a fixed heading. Documentation: [manifest
    reference](manifest-reference.md#evidence).
25. **A no-shell worker was asked to reproduce a failure it could never see
    run.** A job prompt quoted a failure from a runtime check, but the
    assigned worker had no shell and so could never rerun the harness/e2e/
    preview suite that produced it. Rule: warn when a runtime-check failure
    lands in a no-shell worker's prompt, and suggest a shell agent or
    measured evidence instead. Enforcement: `run` warns "worker cannot
    reproduce; consider a shell agent or --evidence" when a job prompt
    quotes a failure from a check whose name contains `harness`, `e2e`,
    `playwright`, or `preview`, or the words "Timeout" and "waitFor", and the
    agent has no shell. Documentation: [manifest
    reference](manifest-reference.md#evidence).
26. **A whole review round's screenshots still needed naming one by one.**
    Even with a directory glob, a round that shared one filename prefix
    still had to spell out every one of its own files by hand. Rule: let a
    glob pattern also match by filename prefix, not only by directory and
    extension. Enforcement: job field `contextGlob` now also accepts
    `dir/prefix*.ext` (still no `**` and no directory wildcards); `validate`
    echoes the expanded file count per pattern so an unexpectedly empty or
    huge expansion is visible before dispatch. Documentation: [manifest
    reference](manifest-reference.md#context-check).
27. **A worker's final answer, still not JSON, made the run look like it had
    no result at all.** A prompt demanded JSON only, but the worker's final
    message still didn't parse, and the run recorded nothing usable even
    though the worker was still reachable. Rule: name the failure plainly
    and give a cheap, bounded chance to correct it on the same session
    before giving up. Enforcement: when a prompt demands JSON only and the
    final message does not parse, the job result is marked `resultMissing:
    true` in state and `inspect`; a `claude` agent gets one cheap re-ask on
    the same session, and that answer is used if it parses. Documentation:
    [verification](verification.md#resultmissing).
28. **A useful mutant needed a whole run's manifest, even for a one-off
    check.** Testing a single guard on the current tree meant writing a
    throwaway manifest and a full run just to reach mutation testing. Rule:
    let mutation testing run directly against the working tree, with no run
    at all. Enforcement: `mutants --mutants-file FILE --mutant-check "<argv
    json>"` applies each `{name,file,find,replace}` entry alone (its `find`
    must match exactly once, else `invalid`), checks it, and restores the
    file byte-for-byte before the next, restoring on `SIGINT` too, and
    reports killed/survived/invalid counts plus the first failing test line.
    Documentation: [verification](verification.md#mutation-checks).
29. **An intended error alarmed a review that expected only failures.** A
    harness view that deliberately triggered an HTTP error to exercise error
    handling was flagged by review as an unexpected failure. Rule: any view
    that intentionally triggers an error belongs on that view's own
    expected-errors list, not treated as a surprise. Enforcement: the
    skill's UI-job boilerplate states this rule directly. Documentation: the
    skill's UI-test prompt guidance.
30. **A brief document that lived outside the project could not be used at
    all.** Useful background for a research job sat in a path outside the
    project root, and the only way to use it was to copy it in by hand
    first. Rule: let a research brief name any readable path, read-only,
    while still keeping a copy for provenance and refusing early on a path
    that cannot be read. Enforcement: `scout`/`sweep --brief` accepts any
    readable path, including one outside the project root; it is copied
    into the scout/sweep directory for provenance, and an unreadable brief
    fails before its job ever backgrounds. Documentation: [manifest
    reference](manifest-reference.md#scout).
31. **A missing CLI and an empty error both hid the same kind of failure.**
    Landing a run failed partway through with a bare error before anyone
    noticed the required CLI simply was not on PATH; separately, a failed
    pull-request lookup gave no detail at all when its own error stream was
    empty. Rule: check that the tools a landing step depends on actually
    exist before doing any real work, and always show what came back, even
    when that is nothing. Enforcement: `ship` resolves `gh` and `git` before
    doing any real work and refuses at once with "gh not found on PATH" (or
    the spawn error text) when either is missing; a `pr list failed` reason
    always includes stderr, or the literal `(empty)` when there is none.
    Documentation: [manifest reference](manifest-reference.md#ship).
