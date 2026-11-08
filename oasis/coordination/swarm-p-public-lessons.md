131. **A log reader's own tests fed it fixture events directly, so its
    mutation-testing score looked strong even though nothing in the real
    system actually produced most of the event names it read.** Rule: a
    reader of logged events needs at least one test fed by a real
    producer's own output. Enforcement: a shared contract now names
    every event a producer writes and a reader reads, and validation
    warns when a listed reader has no matching producer anywhere in the
    batch. Regression coverage is in `tests/field-lessons-batch-p.test.mjs`.
132. **A cheap, bookkeeping-only worker tier was refused for writing a
    small internal note file, even though that exact kind of file was
    already the tier's intended job.** Rule: an allowlist of
    bookkeeping-only output paths should match the files that tier is
    actually meant to write. Enforcement: a small internal note file now
    matches the bookkeeping allowlist; any other design-content file
    still goes to a more capable, still inexpensive tier, and the
    refusal now says so. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
133. **A spend figure shown before a paid job was based on mental
    arithmetic rather than an actual itemized estimate, and the job went
    over its own cap before its own safety step caught it.** Rule: every
    spend figure a cap is set from, and the cap check itself, must come
    from a real itemized estimate computed in code, never arithmetic
    done by eye. Enforcement: a job may now declare a spend cap
    alongside an itemized cost-estimate file; the total is summed in
    code and refused before the job ever starts when it exceeds the cap,
    or when the estimate file cannot be read. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
134. **A declared output with a typo'd name that never existed anywhere
    was read, once nothing showed up for it, as a real deletion and
    blocked the whole change.** Rule: an output missing from both the
    starting state and the finished work was simply never written, not
    deleted, and a typo like this is worth flagging before anything even
    runs. Enforcement: a declared test output absent from the starting
    state now warns up front; an output missing from both the starting
    state and the finished work is now treated as not written, never as
    a deletion. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
135. **A verification command used to score a set of deliberate code
    changes turned out unable to run at all, yet every one of those
    changes still came back with a result that looked like a completed
    score.** Rule: a verification command has to prove it can pass on
    the unmodified code before its result means anything. Enforcement:
    that command now runs once, unmodified, before any deliberate change
    is scored; a command that still cannot pass refuses outright, naming
    why, and any change that comes back unscorable is now called out
    plainly rather than silently averaged in. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
136. **A release request's own title named one version while the
    version recorded in the project and its own change log both still
    named the old one, so nothing was actually tagged and a second
    cleanup was needed to fix it.** Rule: the version bump and the
    release title belong to the same change, checked against each
    other, never trusted to already agree. Enforcement: a release
    request whose title names a version that disagrees with the
    recorded version, or whose change log still marks itself unreleased,
    is now refused before anything ships. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
137. **A time-window check was exercised only ever by clocks already set
    to one particular time zone, so a real event that fell outside the
    window on a different clock went unnoticed by every test that
    covered it.** Rule: code that judges a date or time window needs at
    least one test set to a different time zone, not only the zone every
    other test happens to use. Enforcement: a shared checklist now calls
    this out explicitly, and validation warns when a change touching a
    time-window comparison has no test naming a different zone.
    Regression coverage is in `tests/field-lessons-batch-p.test.mjs`.
138. **A fresh working copy with none of its usual tooling installed yet
    had every one of its checks fail to even start, and that was
    silently scored the same as a real failure of the change itself.**
    Rule: an environment-setup step meant to prepare a fresh working
    copy should run on every attempt, not only when something happened
    to look like it needed it; and a check that never even started is
    not the same thing as a real failure. Enforcement: a setup step now
    runs before checks on every attempt; a setup step that cannot even
    start is now called out plainly instead of being scored as a real
    failure of the change. Regression coverage is in
    `tests/field-lessons-batch-p.test.mjs`.
139. **A pasted standing approval already covering queued work was still
    held for a second confirmation round trip, only because an unrelated
    policy change arrived bundled in the same message.** Rule: work
    already recorded and queued is pre-approved and can start right
    away; a fresh typed confirmation is needed only for genuinely new
    requests, secrets, credentials, material meant for publication, or
    anything that spends money. Enforcement: the coordination guide and
    the onboarding instructions both now state this rule at the point
    work begins. Regression coverage is in `tests/kickoff.test.mjs`.
