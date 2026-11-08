# Project Swarm architecture

Generated 2026-10-01 from project-swarm 1.40.0, repository commit `901a4cd847fac71dca84124c32d4bbabe5fd4d3f`. The editable source is `project-swarm.json`; the standalone rendered artifact is `project-swarm.html`.

The single architecture map contains **73 components, 70 relationships, six regions and five navigation views**. The architecture schema has no component or region ceiling, so no separate lifecycle artifact was needed. This is a detailed repository/module map, not a deployment diagram. Regions organize responsibilities; they do not imply six separate processes or six security sandboxes. All component labels name real commands, files or functions. Each component has repository source references.

## Reading the map

1. **Orchestrator and inputs:** explicit project root; manifest and contract; worker skills; gotchas; environment, toolchain and port helpers; local configuration and private-name checks.
2. **Commands and dispatch gates:** validation, context coverage, preflight, provider/spend limits, live writer registry, research commands, diagnostics and auxiliary dispatches.
3. **Run engine:** exclusive run claim, manifest/state/base records, selected-file snapshots, dependency scheduling, copied proposal workspaces, adapter dispatch, progress, cancellation and failure logs.
4. **Adapters:** Claude file tools, Claude shell, Codex, Hermes/Qwen and API transports. Worktrees, sandbox profiles, scratch directories, structured output and fallback behavior are distinguished.
5. **Review and delivery:** inspect, guarded integration, checks and mutations, metrics, optional CI-derived checks, PR body gates, push, exact-head CI, owner hold and merge verification. Authored lessons feed later prompts.
6. **Installation and maintenance:** versioned user installation and `current`, project linking, release updates, project migration, pin checks and branch squashing.

Arrows assert the labeled call, read, write or artifact flow. The map does not invent an automatic run→integrate→ship approval: the orchestrator invokes those commands, and `go` receives explicit callbacks. Independent maintenance commands have no invented connecting arrows. Cards expand the conditions and exceptions on the nodes. Use the viewer's navigation views, finder and zoom to inspect this dense map; fit-to-page is an index, not a readable substitute for inspecting a region.

## Accuracy details

- The implementation requires `model`; `tier` is optional metadata, with a reason required for `expensive`. It is not a model-routing switch.
- `after` really copies changed predecessor outputs into dependent proposal workspaces. Codex rejects `after`. Explicit integration deletes exist, but Codex refuses missing declared outputs during collection.
- The API context gate is 200,000 bytes in total; serialization truncates each individual file at 60,000 bytes and records it. Tool-free adapters cannot run tests. The parent validates envelopes and applies their files or exact edits.
- Claude file-tools mode cannot run shell tests. Claude shell runs tests behind its Anthropic-only proxy policy. Codex runs tests with filesystem restrictions, but its inspected outer profile does not deny network. These policies are not interchangeable.
- OpenRouter has bounded retry behavior for empty length-truncated output; “single-request adapter” does not mean exactly one HTTP request under every condition. Its pricing/cap checks do not prove a transactional concurrent spend reservation.
- `agent.log` is a per-job failure artifact; `agent-log` is not a recognized command in this revision. There is no automatic log-to-lessons writer.
- Integration checks run after output writes; failed checks do not roll those writes back. The direct `integrateRun` private-name parameter is conditional and is not forwarded by the inspected integrate CLI. Ship has its separately wired private-name gate.
- A missing required PR section refuses before push. An owner-review hold is evaluated after green CI; the actual predicate is the first nonblank trimmed body line starting with `**needs`. A held PR is not merged.
- `packaging-check` participates in validate/integrate/ship. The inspected installer does not call packaging-check, preflight or check-pins, so those installation edges are deliberately absent.

## Regenerate

Run these exact commands from the repository root with Node on PATH. They use only the permitted archify operations; no hooks, browser, network, paid generation or provider calls are used to author/render/check the diagram.

```sh
node docs/_swarm/archify/bin/archify.mjs validate architecture docs/_swarm/diagrams/project-swarm.json --repo-root . --json
node docs/_swarm/archify/bin/archify.mjs render architecture docs/_swarm/diagrams/project-swarm.json docs/_swarm/diagrams/project-swarm.html --repo-root .
node docs/_swarm/archify/bin/archify.mjs check docs/_swarm/diagrams/project-swarm.html --json
```

For a future code revision, re-read the implementation, update the affected labels/cards/arrows and source ranges, and change `meta.repository.revision` before regenerating. A passing geometry receipt does not establish that architectural claims remain current.

## Provenance and verification

- Renderer: read-only vendored **archify d5a1333, MIT**, as pinned in the supplied task. No renderer, runtime, schema or existing repository file was edited.
- Rendering: `animation: none`, `quality_profile: standard`, English; repository links use `local-only`. No downloaded brand assets or capture workflow.
- Architecture validation: **pass**, exit 0. HTML artifact check: **pass**, exit 0; all nine automated checks pass.
- Composition: zero errors; six standard-profile warnings (five proper route crossings and one desktop fit/readability warning). Zero label-route clearance issues, zero clipped labels, zero ambiguous corridors, zero arrowhead collisions. Eighteen additional crossovers are resolved by the renderer. The map is intentionally dense and needs viewer zoom for detail.
- These are automated checks only. No browser, screenshot or perceptual review was performed. The lower-level `render` command does not emit a delivery provenance receipt; `check` reports provenance `unknown`. The provenance recorded here is not a claim of `finalize`/`deliver` certification.
- Project tests: `npm test` ran **1,214 tests: 1,201 passed, 4 failed, 9 skipped** (exit 1). All four failures reported `sandbox-exec: sandbox_apply: Operation not permitted` in this worker's already sandboxed environment: `tests/claude-shell.test.mjs:388`, `tests/shell-loopback.test.mjs:188`, `tests/shell-loopback.test.mjs:215`, and `tests/shell-setup.test.mjs:235`. No tests or production code were changed to bypass this environment limitation. The suite is not claimed green.

## unverified

1. `tools/go.mjs` internals: not in the supplied read context. Only the `tools/swarm.mjs` dispatch and injected callbacks are represented. Internal sequencing, retry, rollback and recovery edges are omitted.
2. `tools/verify-orb.mjs` internals: not in the supplied read context. Only its CLI dispatch is shown. Provider/probe internals and persistence edges are omitted.

No live provider availability, credentials, paid credits, deployed installation or external GitHub state was verified. The diagram describes the inspected code, not current operations.
