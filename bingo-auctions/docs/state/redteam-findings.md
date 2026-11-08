# RED TEAM findings checklist

Built from every finding RED TEAM has raised, so a re-review does not
rediscover the same class of bug one round at a time (#720).

## Before asking RED TEAM for a re-review

1. Run the tests named in the registry below for the area you touched.
2. Run the registry guard: `node scripts/ci/red-team-checklist.mjs`.
3. Walk the checklist for every path your PR changes. If a finding applies
   and there is no test for it, add the test first.
4. Say it in the request, plainly:

   > Checklist run: the registry guard passes and the tests below pass on
   > `<sha>`. Findings checked: `<IDs>`.

Do not claim a checklist pass you did not run. "I fixed the finding" and
"there is a test that fails on the old code and passes on the new code" are
different sentences.

Every RED TEAM review request and every review contract must include this
exact paragraph:

RED TEAM reviews code only. Owner approvals are out of scope. The ship gate checks those, including approvals relayed by Chief of Staff or posted through an app. Never FAIL or BLOCK a PR over how Braden's yes was posted.

## Ship/verdict rules

- RED TEAM reviews code only. Owner approvals are out of scope. The ship gate checks those, including approvals relayed by Chief of Staff or posted through an app. Never FAIL or BLOCK a PR over how Braden's yes was posted.
- `PASS` is valid only from the ChatGPT Codex Connector app
  (`performed_via_github_app.id = 1144995`) and only for the current head SHA.
- A verdict inside an HTML comment, an unclosed/indented/blockquoted code
  fence, or after a non-whitespace fence suffix is not a verdict.
- Changed-file lists must be complete. A truncated list (>100 files, or a
  failed page read) is unverified, never a pass.
- Renames carry `previous_filename`; a rename out of a sensitive path still
  counts as a change to that path.
- `BLOCK`/`FAIL` newer than the head wins over an older `PASS`.
- A rollback needs a real command and a `Who:` / `Check:` at or after the head.

## Help chat privacy (#645)

- [ ] YAML quoted escapes (`\"`, `''`, `\uXXXX`) are decoded before key match.
- [ ] YAML hex escapes (`\xHH`, `\UXXXXXXXX`) are decoded before key match.
- [ ] Multi-line, folded and wrapped scalars are consumed to the end.
- [ ] Explicit mappings (`? key` / `: value`) work with comments and blank
      lines between the key and the value.
- [ ] Anchors and aliases cannot hide a credential at the definition.
- [ ] Multiword quoted and unquoted CLI values are scrubbed whole.
- [ ] Flow maps and combined YAML modifiers are handled.
- [ ] An unterminated quoted/flow scalar fails closed (redacts, not leaks).

## Staff feedback PII (#711)

- [ ] Contact details are caught after percent and HTML encoding, including
      double encoding (`%2540`).
- [ ] Names are caught in lowercase, ALL-CAPS and accented forms.
- [ ] Ordinary UI phrases ("shelf location will not save") are not redacted.
- [ ] Contact details in arbitrary screen paths and query strings are caught.
- [ ] Every field of every row is redacted and fenced as untrusted.
- [ ] Paging is deterministic (`created_at`, then `id`).
- [ ] Dedupe markers are exactly 16 hex characters.
- [ ] A page-ceiling or partial create run fails loudly, not silently.

## Ship gate, labels and auto-merge (#647)

- [ ] A real `VERDICT: GO|PASS` line is required; invented variants fail.
- [ ] Fake PASS text in HTML comments or code fences is ignored.
- [ ] Renamed files cannot dodge the sensitive-path check.
- [ ] A failed or incomplete changed-file read fails closed.
- [ ] `updated_at` decides BLOCK precedence; same-head BLOCK always wins.
- [ ] Labels, files and checks are bound to the gate head.
- [ ] The gate re-runs immediately before `--match-head-commit`.
- [ ] An OTA requires the merged SHA to be the checked-out HEAD.
- [ ] `ship-freeze` and `safety-brake` labels block.
- [ ] A rollback needs non-empty `Who:` and `Check:`.

## Migrations (#718)

- [ ] Target rows are locked before the rows that reference them.
- [ ] Lock order follows the real key (composite where it is composite).
- [ ] Eligibility is re-read after locking, not before.
- [ ] Eligibility re-read and the write use the same snapshot.
- [ ] A rollback repeats its guard and locks what it restores.
- [ ] A concurrent put-away cannot move a target to an unlocked bin.
- [ ] A dry run on a scratch database covers: eligible run, second-run no-op,
      a should-abort case, and rollback.

## Photo queue (#683)

- [ ] Every read-modify-write of the persisted queue shares one lock.
- [ ] Network work stays outside the lock.
- [ ] A deterministic test pauses the drain's final write, enqueues a photo,
      and asserts the new photo survives.

## Registry

Rows marked `open-pr` live on that PR's branch until it merges; flip the
status to `merged` in the same PR that lands the test.

<!-- redteam-registry:start -->

| ID          | Finding                                                           | Test                                                                  | Status  |
| ----------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------- |
| RT-HLP-01   | Quoted YAML escapes hide credentials                              | `apps/operator-web/src/lib/help-chat/__tests__/scrub-secrets.test.ts` | open-pr |
| RT-HLP-02   | Hex escapes (`\xHH`, `\UXXXXXXXX`) hide credential keys           | `apps/operator-web/src/lib/help-chat/__tests__/scrub-secrets.test.ts` | open-pr |
| RT-HLP-03   | Multi-line and folded scalars escape redaction                    | `apps/operator-web/src/lib/help-chat/__tests__/scrub-secrets.test.ts` | open-pr |
| RT-HLP-04   | Explicit mappings (`? key` / `: value`) with comments/blank lines | `apps/operator-web/src/lib/help-chat/__tests__/scrub-secrets.test.ts` | open-pr |
| RT-HLP-05   | Escaped keys hide credentials                                     | `apps/operator-web/src/lib/help-chat/__tests__/scrub-secrets.test.ts` | open-pr |
| RT-HLP-06   | Aliases hide a credential at the anchor definition                | `apps/operator-web/src/lib/help-chat/__tests__/scrub-secrets.test.ts` | open-pr |
| RT-HLP-07   | Multiword quoted and unquoted CLI values                          | `apps/operator-web/src/lib/help-chat/__tests__/scrub-secrets.test.ts` | open-pr |
| RT-HLP-08   | Flow maps and combined modifiers                                  | `apps/operator-web/src/lib/help-chat/__tests__/scrub-secrets.test.ts` | open-pr |
| RT-HLP-09   | Unterminated quoted/flow scalar must fail closed                  | `apps/operator-web/src/lib/help-chat/__tests__/scrub-secrets.test.ts` | open-pr |
| RT-FB-01    | Encoded contact info (`%40`, `%2540`, `&#64;`)                    | `scripts/__tests__/feedback-sync.test.mjs`                            | open-pr |
| RT-FB-02    | Lowercase, ALL-CAPS and accented names                            | `scripts/__tests__/feedback-sync.test.mjs`                            | open-pr |
| RT-FB-03    | Ordinary UI phrases must survive redaction                        | `scripts/__tests__/feedback-sync.test.mjs`                            | open-pr |
| RT-FB-04    | Contact info in arbitrary paths and query strings                 | `scripts/__tests__/feedback-sync.test.mjs`                            | open-pr |
| RT-FB-05    | Every row field fenced as untrusted                               | `scripts/__tests__/feedback-sync.test.mjs`                            | open-pr |
| RT-FB-06    | Deterministic paging by `created_at, id`                          | `scripts/__tests__/feedback-sync.test.mjs`                            | open-pr |
| RT-FB-07    | 16-hex dedupe markers                                             | `scripts/__tests__/feedback-sync.test.mjs`                            | open-pr |
| RT-FB-08    | Partial/ceiling runs fail loudly                                  | `scripts/__tests__/feedback-sync.test.mjs`                            | open-pr |
| RT-GATE-01  | Only a real `VERDICT: GO \| PASS` counts                          | `scripts/__tests__/ship-gate.test.mjs`                                | open-pr |
| RT-GATE-02  | Fake PASS in HTML comments and code fences                        | `scripts/__tests__/ship-gate.test.mjs`                                | open-pr |
| RT-GATE-03  | Renamed files cannot dodge the path check                         | `scripts/__tests__/ship-gate.test.mjs`                                | open-pr |
| RT-GATE-04  | Truncated/failed file list fails closed                           | `scripts/__tests__/ship-gate.test.mjs`                                | open-pr |
| RT-GATE-05  | BLOCK precedence by `updated_at`; same-head BLOCK wins            | `scripts/__tests__/ship-gate.test.mjs`                                | open-pr |
| RT-GATE-06  | Labels, files and checks bound to the gate head                   | `scripts/__tests__/ship-gate.test.mjs`                                | open-pr |
| RT-GATE-07  | Gate re-runs before `--match-head-commit`                         | `scripts/__tests__/ship-gate.test.mjs`                                | open-pr |
| RT-GATE-08  | OTA ancestor check                                                | `scripts/__tests__/ship-gate.test.mjs`                                | open-pr |
| RT-GATE-09  | `ship-freeze` / `safety-brake` labels block                       | `scripts/__tests__/ship-gate.test.mjs`                                | open-pr |
| RT-GATE-10  | Rollback needs real `Who:` and `Check:` at/after head             | `scripts/__tests__/ship-gate.test.mjs`                                | open-pr |
| RT-LABEL-01 | A sensitive path applies `needs-braden` at open                   | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-02 | A rename out of a sensitive path still applies the label          | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-03 | All changed-file pages are read (>100 files)                      | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-04 | PR head code never runs with the label write token                | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-05 | CamelCase money/refund paths and renames apply the label          | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-06 | Incomplete or 3,000-capped file lists fail closed                 | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-07 | Fork/Dependabot events use the trusted labeling route             | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-08 | Base retarget reclassifies, bound to base and head                | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-09 | Label job runs default-branch code, never a PR base SHA           | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-10 | money-daily, reports/money and shared money paths are labeled     | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-11 | A rename cannot inflate the changed-file completeness count       | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-12 | Sweep paginates all open PRs and fails loudly when listing fails  | `scripts/__tests__/needs-braden-label.test.mjs`                       | merged  |
| RT-LABEL-13 | Duplicate filenames / excess records fail the file-list check     | `scripts/__tests__/needs-braden-label.test.mjs`                       | open-pr |
| RT-REG-01   | Malformed/extra/missing-cell rows fail, not disappear             | `scripts/__tests__/red-team-checklist.test.mjs`                       | merged  |
| RT-REG-02   | Merged rows must cite a real test file, not a dash/dir/manifest   | `scripts/__tests__/red-team-checklist.test.mjs`                       | merged  |
| RT-REG-03   | Registry test paths are canonical `__tests__` and located         | `scripts/__tests__/red-team-checklist.test.mjs`                       | merged  |
| RT-REG-04   | A row with a dropped leading pipe fails instead of vanishing      | `scripts/__tests__/red-team-checklist.test.mjs`                       | merged  |
| RT-REG-05   | Merged test paths reject traversal and escaping symlinks          | `scripts/__tests__/red-team-checklist.test.mjs`                       | merged  |
| RT-REG-06   | Fixtures and test-named symlinks to non-tests are rejected        | `scripts/__tests__/red-team-checklist.test.mjs`                       | open-pr |
| RT-REG-07   | Duplicate/nested or a second registry section is rejected         | `scripts/__tests__/red-team-checklist.test.mjs`                       | open-pr |
| RT-REG-08   | Real `packages/db/test/*.sql` regression tests are accepted       | `scripts/__tests__/red-team-checklist.test.mjs`                       | open-pr |
| RT-REG-09   | Literal POSIX backslashes are filenames, not path separators      | `scripts/__tests__/red-team-checklist.test.mjs`                       | open-pr |
| RT-MIG-01   | Target lots locked before referencing rows, re-check after        | `—`                                                                   | planned |
| RT-QUEUE-01 | Queue read-modify-write shares one lock (enqueue vs drain race)   | `apps/field-mobile/lib/photo-upload-queue.test.ts`                    | open-pr |

<!-- redteam-registry:end -->
