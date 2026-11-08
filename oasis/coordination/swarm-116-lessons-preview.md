18. **A mutant could not be declared before the code it targets existed.** A
    build job's generated code held the only string a useful mutant's `find`
    could match, so that mutant could not be written into the manifest before
    the run even started, and the orchestrator fell back to a hand-written
    mutation loop again. Rule: let mutants be supplied once the code they
    target actually exists, under the same shape and cap as declared ones.
    Enforcement: `integrate <run-id> --mutants --mutants-file FILE` loads
    mutants from a JSON array or `{mutants:[...]}`, and a job field
    `mutantsFile` (one of that job's own outputs) is collected automatically;
    `--mutant-check "<argv json>"` supplies the check when the manifest
    declares none. Documentation:
    [manifest reference](manifest-reference.md#mutation-checks) and
    [verification](verification.md).
19. **A failed job kept only "missing output," not why.** A worker exited
    non-zero, or wrote none of its declared outputs, and the run reported
    only `Missing output (deletions are never propagated): <file>`; the
    worker's own explanation — a `blocked` envelope naming what it needed, or
    a provider's plain "out of credits" line — lived only in an unread
    stderr log. Rule: keep a worker's own failure reason next to the job
    record, and never let a later generic message stand in for a `blocked`
    envelope. Enforcement: the last 4 KB of stdout/stderr are saved to
    `agent.log` and summarized as `agentError` (exit code plus the first
    matching blocked/credit/quota/rate-limit/auth line, else the last
    stderr line), shown in `inspect`/`inspect --results`, with secrets
    redacted; a worker's own `blocked` envelope is reported as job status
    `blocked` with its summary instead. Documentation:
    [verification](verification.md#agent-failure-evidence).
20. **A review round's context quietly dropped new captures.** A reviewer's
    context was copied from the previous round and never updated, so new
    screenshots landed in the same directory without ever reaching the
    job, and the reviewer reported already-fixed items as still missing.
    Rule: warn when a job's context names most, but not all, files of one
    kind in a directory, and offer a way to include a whole directory
    instead of naming files by hand. Enforcement: `validate`/`run` warn
    `context lists k of n .ext in <dir>; missing e.g. a.ext, b.ext (+m
    more)` when context names 3+ files of one extension from a directory
    that holds others it omits; job field `contextGlob` (`["dir/*.ext"]`,
    no `**`) expands to every matching file at validate/run time.
    Documentation: [manifest reference](manifest-reference.md#context-check).
