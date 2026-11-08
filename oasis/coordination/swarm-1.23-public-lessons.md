# swarm 1.23.0 — public lessons 74–79 (for Braden's OK before push)

74. **A path flag was read against the target directory, not the one it was
    typed from.** A research run named its input file the way it was typed,
    sitting in one directory while pointed at another; the file was read only
    against the pointed-at directory, so a plainly-relative path failed "not
    found" even though it existed exactly where it was typed. Cost one
    re-run (seconds). Rule: a path flag resolves the way the user typed it —
    tried against the directory they were sitting in before the one the
    command was pointed at. Enforcement: every such flag is now tried against
    the current directory first, then against the pointed-at one; a truly
    missing file names every path actually tried. Regression coverage is in
    `tests/field-lessons-batch-g.test.mjs`.
75. **A worker hand-reverted a mutant and wiped its own unrelated edit to the
    same file.** A mid-tier worker, undoing a mutant by hand, ran a plain
    revert command on the mutated file and lost uncommitted work of its own
    sitting in that same file; recovery needed a full re-run of the check
    suite and every mutant to confirm nothing else had been lost. Rule:
    workers never hand-revert a mutant; the tool that applies one also
    restores it. Enforcement: the guard that already refused a shared-stack
    stash command now also refuses a plain revert of any path that still has
    uncommitted changes, naming the fix in its own refusal message; job
    instructions for any worker with shell access now say to run mutants only
    through the tool, never by hand. Regression coverage is in
    `tests/field-lessons-batch-g.test.mjs`.
76. **One mutants shape was expected, but a worker wrote a different one.** A
    worker's own mutants file used a different key for a mutant's name than
    the one the mutation tool reads, so the difference had to be converted by
    hand before the tool would accept the file. Rule: state the one true
    shape everywhere a worker can read it, and let the tool bridge the common
    near-miss instead of failing outright. Enforcement: the mutation tool now
    accepts the old key as an alias for the new one (renamed, with a
    warning), and the paste-ready environment block states the exact shape
    alongside every other rule a worker needs. Regression coverage is in
    `tests/field-lessons-batch-g.test.mjs`.
77. **A check that could not even start reported no reason at all.** A
    pre-push lock check spawned a toolchain binary that was not on a bare
    system path (it lived only in a dedicated toolchains directory); the
    check refused with a blank reason, costing one re-attempt (about three
    minutes) before the real cause was found. Rule: a check that cannot start
    says so, naming the command it tried. Enforcement: that toolchain binary
    is now resolved the same way every other one is (a dedicated toolchains
    directory, then the system path) before it is ever spawned; when it
    cannot be found, the check refuses at once, naming every path it tried.
    Regression coverage is in `tests/field-lessons-batch-g.test.mjs`.
78. **A required section was refused for carrying extra words in its own
    heading.** A gate that required a named section refused a real section
    whose heading added a short parenthetical after the required name, even
    though the section itself was present and filled in. Rule: match a
    required heading by its name plus a following word boundary (end of
    line, a space, or an opening parenthesis), not by an exact match, so a
    heading that only shares a name's first word without a boundary still
    correctly fails to match. Enforcement: the section-matching rule was
    changed from an exact heading match to this boundary-prefix match, and a
    refusal for a section that is genuinely absent now also names the
    heading in the body that came closest to matching, to save a guess.
    Regression coverage is in `tests/field-lessons-batch-h.test.mjs`.
79. **A missing toolchain gave a check failure with no program or path
    named.** A local check step spawned a bare tool name from a shell whose
    session did not have the dedicated toolchains directory on its path,
    and every such check failed with a bare, generic status and no
    indication of what was missing or where it looked. Rule: reuse the one
    resolver that already checks a dedicated toolchains directory before the
    system path for any check's own command, not only the one binary that
    previously had this treatment, and name every location tried when
    nothing is found. Enforcement: local check execution resolves a bare
    command through that shared resolver before ever spawning it; one that
    cannot be resolved anywhere refuses only that check, naming the command
    and every path tried, instead of a bare, uninformative failure.
    Regression coverage is in `tests/field-lessons-batch-h.test.mjs`.

80. **A read-only research worker's own "it's missing" claim was taken as
    fact.** A read-only worker, given a fixed set of context files, reported
    that a piece of behavior was dropped — an allowlist omitted it, a
    callback was never invoked — when the truth lay entirely in a file
    outside that fixed context; the claim read as a finding, not a guess
    bounded by what the worker was shown. A follow-up job spent on the order
    of 100k tokens proving there was no bug before the mistake was caught.
    Rule: a worker reading only a fixed context list cannot tell a genuine
    absence from a file it was never given, so any claim of one must say so
    and name what it searched. Enforcement: the worker's own prompt now
    states that a claim of something missing, never called, omitted, or
    absent must carry a basis marker naming the claim as context-only, plus
    what was searched; the result also carries back the exact context list
    the worker was given, and gains a warning naming the result "limited by
    context" whenever the worker's own answer text contains an absence claim
    (a simple, case-insensitive, whole-word scan for a handful of such
    words), independent of whether the worker itself added the basis marker.
    Regression coverage is in `tests/field-lessons-batch-i.test.mjs`.
