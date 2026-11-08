158. **A worker's own report of an unmet rule read the same as a silent
    workaround.** A worker faced a contract requirement it genuinely could
    not satisfy inside its own declared outputs, but had no structured way
    to say so short of stopping outright, so a reviewer could not easily
    tell a deliberate, reasoned deviation apart from a worker that just
    quietly did something else instead. Rule: let a worker report a
    deviation it could not avoid, with what the rule was, what it did
    instead, and why, and require a person to accept it explicitly before
    it lands. Enforcement: a result may carry a `deviations` list read at
    review time and again before landing; landing refuses outright unless
    that acceptance is explicit, and an accepted deviation is recorded
    alongside the change instead of disappearing into a worker's own notes.
    Regression coverage is in `tests/field-lessons-batch-u.test.mjs`.
159. **A new dependency on a platform-only backend had no test for the
    backend being unavailable.** A change added a runtime dependency on a
    platform API (a keychain, say) reachable on a startup path, but nothing
    proved the program still started when that backend failed or was
    simply absent, which is exactly the environment a good share of real
    machines present. Rule: any new platform-bound dependency on a startup
    path needs one test that forces its backend to fail and proves startup
    still succeeds, with the dependency built lazily behind a factory so a
    test can swap it out. Enforcement: the shared contract template's own
    test checklist now states this requirement directly. Regression
    coverage is in `tests/field-lessons-batch-u.test.mjs`.
160. **A private term left a branch's history even though the final diff
    never showed it.** A term that must never reach a public remote was
    added in one commit and removed again in a later commit of the same
    branch; the existing guard compared only the cumulative diff against
    the branch's base, which no longer contained the term at all, so the
    scan missed it and the term still travelled inside that first commit's
    own history once pushed. Rule: a guard over what a branch will publish
    must judge every commit it will actually publish, not only the net
    change between endpoints. Enforcement: publishing now scans each
    commit's own added lines and message for a configured private term,
    refusing before any push and naming only the offending commit and the
    term's position in the list, never the term itself. Regression
    coverage is in `tests/field-lessons-batch-u.test.mjs`.
161. **A held review request carried no fixed shape for what a reviewer
    actually needed to see.** A pull request held for a named reviewer's
    attention read like any other held request, so the reviewer had to
    hunt through the whole body for what changed, what could break, and
    what evidence backed it, every single time. Rule: a request held for
    that reviewer carries a fixed three-field summary — what changed, what
    could break, and the proof — surfaced the moment the hold happens, not
    buried in prose. Enforcement: a hold whose body opens with that
    reviewer's own marker now gains a structured summary built from the
    body's own Summary, Could break, and Mutation check sections (a
    missing Could break section becomes an explicit fill-in-later marker,
    never blank), printed at the point the hold decision is made.
    Regression coverage is in `tests/field-lessons-batch-u.test.mjs`.
162. **A worker's own passing status and its own evidence disagreed, and
    nothing noticed.** A job's report named a check "passed" while the very
    same report's own text still carried a nonzero failure count for that
    check — a self-contradiction sitting in plain sight inside one report,
    caught only if a reviewer happened to read the whole thing closely.
    Rule: a report that grades itself is cheap evidence next to what its
    own numbers already say, and the two should never be allowed to
    quietly disagree. Enforcement: review now scans a job's own reported
    text for a nonzero failure count and warns when a check the same
    report calls "passed" is contradicted by it. Regression coverage is in
    `tests/field-lessons-batch-u.test.mjs`.
163. **A narrowed check environment warned about programs it never used at
    all.** A check that ran with a deliberately narrowed set of paths
    warned about every common program missing from that narrowed set, even
    ones the check itself never invoked, so a real gap (the one program the
    check actually needed) was buried in noise about programs that were
    never relevant to it. Rule: a missing-program warning belongs only to
    the program a check's own command line actually runs, not to every
    program a fixed list happens to name. Enforcement: the warning now
    resolves the actual invoked program (skipping past a leading
    environment-variable prefix, and treating one particular tool as
    implying a second one underneath it) before checking whether that
    program, specifically, is missing. Regression coverage is in
    `tests/field-lessons-batch-u.test.mjs`.
164. **A sandboxed job's own scratch-directory temp path did not reach its
    own temp-directory environment variables.** A sandboxed job's own
    tests could call the standard "create a temp directory under the
    system temp path" pattern and still land outside the one directory the
    sandbox actually grants that job read/write access to, because nothing
    guaranteed the system temp-path variables pointed at that job's own
    scratch directory in the first place. Rule: a sandboxed job's own
    temp-directory environment variables always point at that job's own
    scratch directory, the one its own sandbox already grants access to,
    never the bare system default. Enforcement: a sandboxed job's launch
    environment sets its temp-directory variables to its own scratch
    directory; an unsandboxed job's environment is unaffected. Regression
    coverage is in `tests/field-lessons-batch-u.test.mjs`.
