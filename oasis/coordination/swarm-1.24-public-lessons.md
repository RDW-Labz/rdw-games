81. **A hand-typed check list drifted from what CI actually ran.** A format
    check CI never ran failed on a batch of already-unformatted files, and
    ship's own hand-typed checks had already passed, so the drift was found
    only once CI itself ran — costing one wasted re-ship. Rule: a hand-typed
    check list is a guess at what CI runs, and guesses drift; a check that
    already fails on the commit being shipped from proves nothing about what
    the change itself broke. Enforcement: ship can now read a CI workflow's
    own run steps directly and use them as its own checks, and warns when a
    hand-typed check's program and subcommand are not among them; separately,
    any check that fails is re-run once against the base commit's own tree (a
    throwaway checkout, always cleaned up) and reported pre-existing — still
    listed, no longer blocking — when it fails there too. Regression coverage
    is in `tests/field-lessons-batch-j.test.mjs`.
82. **Ship stopped on a red CI run whose failing tests the change never
    touched.** A platform-specific, timing-sensitive test suite failed on a
    run that otherwise had nothing to do with the change being shipped, and a
    manual rerun of the same run passed immediately — the wait and the manual
    step were both wasted. Rule: a failing test the change did not touch is
    worth one automatic rerun before it blocks a ship; a failing test the
    change did touch is treated as a real regression and must never be rerun
    away. Enforcement: ship can now rerun a CI run's own failed jobs, up to a
    given number of attempts, but only when none of the tests they failed on
    appear among the files the change itself touched; it reports how many
    attempts it took and whether the rerun passed. Regression coverage is in
    `tests/field-lessons-batch-j.test.mjs`.
83. **A diff guard refused a branch over a call already on its base.** A
    static gate over a changed test file's spawned binaries refused a branch
    for a call that was already present on the base commit, untouched by that
    branch's own diff, and unrelated to what the branch actually did. Rule: a
    guard over what a change touches must judge only the lines that change
    itself adds, never a whole file's current content, or it blames a branch
    for something it did not do. Enforcement: the guard now reads only the
    lines a diff adds to each changed test file before scanning them; one
    documented binary was added to the allowlist (with a platform note, since
    "documented" here means one platform, not every platform); and a
    repeatable, owner-decision exemption flag can excuse one file from one
    named guard, with a required reason, logged and always visible in the
    resulting PR body — never silently applied, never applied to a file or
    guard it wasn't given for. Regression coverage is in
    `tests/field-lessons-batch-k.test.mjs`.
84. **A resolver picked a directory because it passed the same check a file
    would.** A path resolver for a named binary considered a candidate found
    as soon as one existence-and-permission check passed, and a directory
    that happened to share the binary's name passed that same check — so the
    resolver returned a directory, and every attempt to run "it" then failed
    before it ever started, with no message worth reading. Rule: a resolver
    picking a program to run must confirm it is actually a regular,
    executable file, not merely a path that exists and carries an execute
    bit — directories carry that bit too. A step that fails to even start a
    program must never report an empty reason; it must name what could not be
    started and why. Enforcement: the resolver now also requires the
    candidate to stat as a regular file before it counts, and the launcher
    that spawns a resolved path now distinguishes "never started" from "ran
    and exited non-zero," naming the failure either way. Regression coverage
    is in `tests/field-lessons-batch-k.test.mjs`.
