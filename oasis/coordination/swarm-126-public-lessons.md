99. **A dependency probe refused a check whose own interpreter actually
    existed, because the probe resolved the program name against the
    orchestrator's own search path instead of the path the check itself
    would use.** A check invoked through an explicit environment-variable
    prefix (setting its own search path before naming the program) was
    probed as if that prefix were not there at all. Rule: a probe must
    resolve a program the same way the real check will — honoring an
    explicit search-path override first, then a dedicated tools directory,
    then the ordinary search path — and a refusal must name every place it
    looked. Enforcement: the probe now unwraps that prefix, tries the
    dedicated tools directory, and falls back to the ordinary search path,
    listing every directory tried in its refusal. Regression coverage is in
    `tests/field-lessons-batch-l.test.mjs`.
100. **A file carrying a worker's own evidence about which mutant killed
    which test was refused outright over one extra, purely informational
    field.** The shape check treated every field it did not already know
    about as a hard error, with no room for a worker to attach its own
    supporting notes. Rule: a documentation-only field is accepted with a
    warning, never a reason to refuse a file whose real content is
    otherwise valid. Enforcement: two such fields are now accepted and
    carried through, and a worker's own claim about which test killed a
    mutant is compared against what actually failed, warning on a mismatch
    instead of trusting it blindly. Regression coverage is in
    `tests/field-lessons-batch-l.test.mjs`.
101. **A worker that answered a question was reported exactly as if it had
    said nothing at all.** A reply that was almost valid, structured data —
    readable by a person, just not by a strict parser — was reduced to a
    bare empty result plus a generic parse-failure message, with the actual
    answer recoverable only by digging through raw logs by hand. Rule: a
    worker that answered is never reported as empty; a parse failure keeps
    the raw answer reachable, and an easy, well-understood mistake is
    repaired automatically before it is treated as a failure at all.
    Enforcement: a parse failure now tries one narrow, documented repair
    first and reports the raw reply's own location and a leading excerpt of
    it when nothing can be recovered, instead of only a bare empty result.
    Regression coverage is in `tests/field-lessons-batch-l.test.mjs`.
102. **A job that never even got the chance to start looked identical, from
    the outside, to one that ran and produced nothing.** A one-time setup
    step failing before the actual worker ever launched left an empty
    error, empty result, and empty cost — the same shape a worker that ran
    and simply reported nothing would leave — with the real cause visible
    only in a log file nobody was told to open. Separately, a dependency
    lock naming a local file no longer present in the tree was only
    discovered once an offline install actually tried to use it. Rule: a
    job that never started says so, with the setup failure's own tail
    alongside it; a lock naming a path that is not there is flagged before
    anything tries to install it. Enforcement: inspecting a run now names
    the phase a setup failure happened in and includes that failure's own
    log tail, and validation now warns when a dependency lock names a local
    path missing from the tree. Regression coverage is in
    `tests/field-lessons-batch-l.test.mjs`.
103. **A failed check at integration time stayed invisible unless a rarely
    remembered flag was passed, letting a broken change through silently.**
    The default behavior treated a check that failed exactly like one that
    passed, reporting success and requiring extra, easy-to-forget ceremony
    to surface the failure at all. Rule: a failed check at integration time
    is loud by default, never a quiet field a reader has to go looking for.
    Enforcement: integration now refuses by default when a check has
    failed, naming every failed check, with an explicit opt-in for the rare
    case that failure should be accepted anyway. Regression coverage is in
    `tests/field-lessons-batch-l.test.mjs`.
104. **A worker was told to run a check that lived somewhere its own sandbox
    could never reach, and spent its turns discovering that the hard way.**
    A check naming a path outside the worker's own restricted environment
    was indistinguishable, in the instructions it was given, from one it
    could actually run itself. Rule: a check a sandboxed worker is told to
    run must be reachable from within its own sandbox, or the instructions
    must say plainly that a later, unrestricted step runs it instead.
    Enforcement: validation now warns when a check or a job's own
    instructions name a path outside the sandboxed environment, and that
    worker's own boilerplate now marks such a check as run by a later step
    instead of asking the worker to run it itself. Regression coverage is
    in `tests/field-lessons-batch-l.test.mjs`.
105. **An exact pin on a repo's own package was vendored nowhere at all, and
    passed clean.** The stale-pin check only ever compared an exact pin
    against a vendored copy of the same package; a pin with no vendored
    copy to compare against fell through both of its rules instead of
    failing either one. Rule: an exact pin is only trustworthy when it is
    backed by something the tests actually ran against — a vendored copy,
    or an explicit local/override source. Enforcement: an exact pin with
    neither now fails a new rule, in every kind of repo (no exemption for
    the kind of repo that owns the shared core package). Regression
    coverage is in `tests/field-lessons-batch-m1.test.mjs`.
106. **A guard meant to stop a scratch file from ever being pushed judged
    the wrong thing and refused a file that was never going to be pushed
    at all.** It asked whether a run's own declared-output list named a
    scratch-shaped file absent from the base commit — but a declared
    output that is git-ignored and never committed is *also* absent from
    the base commit, so a legitimate, ignored side-effect file was refused
    exactly like a real mistake would have been. Rule: a guard that exists
    to stop something from being pushed must judge the actual diff that
    would be pushed, never a list of what a job merely claims to have
    produced. Enforcement: the guard now reads the real diff between the
    base commit and the current one (plus anything staged) instead of the
    run's declared outputs. Regression coverage is in
    `tests/field-lessons-batch-m1.test.mjs`.
107. **Two workers sharing one machine both burned their last minutes in a
    sleep-and-poll loop, waiting on a full test suite each had launched in
    the background, and both timed out with nothing to show for it even
    though their real work was already finished.** A shell worker told to
    "run the full suite" ran it itself, in the background, and then polled
    it by sleeping — exactly the kind of busy-waiting that starves a
    shared machine when two such workers land on it at once. Rule: a
    worker runs only its own new or changed files; the full suite is the
    orchestrator's job, run once, after the fact. Enforcement: a worker's
    own instructions now say so directly; integrating a timed-out job can
    now accept its already-finished, hash-checked outputs instead of
    discarding them; starting two shell jobs that share a root and both
    ask for a full suite now warns up front; and a timeout result now
    names what the transcript was last doing when time ran out.
    Regression coverage is in `tests/field-lessons-batch-m2.test.mjs`.
108. **A worker fixed a set of failing tests by adding a new field to a
    persisted record, picked its own default for data saved before the
    field existed, and called that choice "stricter" — but that default
    silently made a one-time migration a no-op for every record already on
    disk, which was the entire point of the fix.** Every test was green
    because no test ever loaded a file saved before the field existed.
    Rule: a newly persisted field must state its legacy default in plain
    words, and a test must prove that default by loading a real pre-change
    file from disk — a worker's own judgment about which default is
    "safer" is not a substitute for that. Enforcement: a result schema now
    carries the field's name, legacy default and reasoning; inspecting a
    run warns when a diff adds a field to a persisted record with that
    left empty. Regression coverage is in
    `tests/field-lessons-batch-m2.test.mjs`.
109. **A routing decision that retired a model from the cheap tier landed
    only in a decision log, not in the rulebook a model reads at boot, and
    jobs kept quietly routing to the old, pricier choice.** Rule: a routing
    decision only takes effect once it lands in the document the model
    actually reads before acting, not only in a record meant for humans.
    Enforcement: validation now warns when a job asks for the cheap tier on
    an agent pricier than the configured cheap-tier model, unless the job
    states a reason the cheaper model was skipped. Regression coverage is
    in `tests/field-lessons-batch-m2.test.mjs`.
110. **A public tool hard-coded a private product's keychain service name,
    an app-support path, and a product-specific denied-directory entry.**
    A contract written for one project's own conventions was carried
    faithfully into a tool meant to be read by anyone. Rule: a public-repo
    tool names no private product specifics directly; project-specific
    values arrive through local configuration, with a generic default.
    Enforcement: all three now default to generic values, overridden only
    through local config. Regression coverage is in
    `tests/field-lessons-batch-m3.test.mjs`.
111. **A tool-free API worker's reply, cut short by an output-length limit,
    surfaced only as a bare "incomplete or unexpected" error with no way
    to tell why from the error alone.** Rule: a failure to parse a
    worker's reply names the actual reason it failed, not just the fact
    that it did. Enforcement: the error now names the provider's own
    finish reason (e.g. truncated by length) directly. Regression coverage
    is in `tests/field-lessons-batch-m3.test.mjs`.
