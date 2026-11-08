
113. **A tool-free worker asked to return a large existing file whole, in
    one reply, ran out of its own output budget partway through, and the
    failure was reported as a generic "incomplete or unexpected" error.**
    Rule: a worker changing only part of a large file should say so as
    one exact find-and-replace, never the whole file, and a system that
    cannot know in advance whether a worker will choose that should warn
    up front instead of guessing. Enforcement: a tool-free worker's
    structured reply may now name one exact find/replace pair per
    declared output instead of returning it whole, refused outright when
    the text to find is missing or matches more than once; validation
    now warns when an existing declared output is already large enough
    that asking for it whole risks the same failure. Regression coverage
    is in `tests/field-lessons-batch-n.test.mjs`.
114. **An idle window between hand steps went unnoticed until it had
    already cost real time, because nothing checked whether a job was
    actually running before the next hand step began.** Rule: check that
    a job is running before any hand step, and account for idle time the
    moment it happens rather than only after the fact. Enforcement: a
    coordinator now warns before certain hand steps when no job is
    running anywhere under its configured project roots, naming how long
    it has already been idle; a background-time reader now lists every
    idle gap of five minutes or more between recorded windows.
    Regression coverage is in `tests/field-lessons-batch-n.test.mjs`.
115. **A named license exception for one specific package was written
    down as prose for a worker to remember, and the automatic license
    gate rejected that same package anyway, needing a manual fix
    afterward.** Rule: a named exception is configuration a gate
    enforces, not prose a worker or a later reviewer has to remember.
    Enforcement: a scouting tool now accepts a repeatable per-package
    license exception that keeps a matching pick in the results,
    distinctly marked, while every other pick under the same license is
    still rejected. Regression coverage is in
    `tests/field-lessons-batch-n.test.mjs`.
116. **A scouting tool's license gate was a fixed list built for source
    code, so a search explicitly allowed to use permissive asset
    licenses had every real result rejected, and an extra report section
    the search brief asked for was silently dropped by a fixed report
    layout.** Rule: the list of allowed licenses is exactly what the
    search brief says it is, not a fixed built-in assumption, and an
    extra section a brief asks for must survive into the final report.
    Enforcement: the allowed-license list can now be replaced outright
    from a file or a plain list, a preset exists for common permissive
    asset licenses (flagging the one that requires attribution), and any
    extra section a report includes now renders in the final document.
    Regression coverage is in `tests/field-lessons-batch-n.test.mjs`.
117. **A coordinator overrode its own git identity to make a commit
    land, and the hosting service refused the resulting push over an
    email-privacy setting, requiring several commits to be redone.**
    Rule: never override git identity; the repository's own
    configuration decides. Enforcement: shipping now refuses, before any
    push, when a commit in the change carries an author or committer
    email that is neither the repository's configured address nor a
    hosting-service-issued privacy address. Regression coverage is in
    `tests/field-lessons-batch-n.test.mjs`.
118. **A regression check across several stacked changes to the same
    file could not tell whether an older change still mattered, because
    the reconstruction it relied on assumed only one change had ever
    touched that file.** Rule: a regression check across stacked changes
    must work on the tree as it now stands, not on bookkeeping that
    assumed no later change would touch the same file. Enforcement: a
    regression check can now target one specific change directly,
    reverting only that change's own effect on a disposable copy of the
    current tree, and it now says plainly when every failure it saw was
    only a loading error rather than real evidence. Regression coverage
    is in `tests/field-lessons-batch-n.test.mjs`.
119. **A worker with no ability to run tools of its own was pointed at
    reference material it needed for its task, but that material never
    actually reached the request sent to it, and the run was still
    reported as finished successfully with nothing usable to show for
    it.** Rule: a worker with no tools of its own must have its
    reference material actually delivered to it, or the task should be
    refused outright; a result that amounts to nothing is never reported
    as finished successfully. Enforcement: reference material for such a
    worker is now inlined directly into its request, with a size limit
    per file and a record of what was actually included; material that
    cannot be delivered this way now refuses the task up front, and an
    empty result from such a worker is now reported as failed rather
    than finished. Regression coverage is in
    `tests/field-lessons-batch-n.test.mjs`.
