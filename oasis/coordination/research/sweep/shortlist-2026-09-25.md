# 12-area sweep shortlist — 2026-09-25

**Braden's decision (2026-09-25):** adopt nothing now. Read when that ticket starts: **apache/casbin-pycasbin (T28)**, **routablehq/python-quickbooks (T33)**, **qdrant/qdrant (Phase 3)**. Voice picks (KoljaB/RealtimeSTT, amsehili/auditok, k2-fsa/sherpa-ncnn) wait with T18. All other picks dropped.

Runs: sweep-1790385124779 (12 areas, $0.53) + sweep-1790385304683 (re-run of 3 empty areas with topic queries, $0.23). Sonnet. License allowlist and 40-hex pins come from GitHub data, not the model. Nothing is adopted until Braden says yes per pick.

## t19-ui-onboarding (T19)

- **[mui/base-ui](https://github.com/mui/base-ui)** — MIT · pin `45a75a5785046af3700ac5671ecde620cdff8900` · ~40 h · fit: reference-only · ★10997 · flags: install-scripts
  - Why: Unstyled, WAI-ARIA-accessible primitives — ideal base for token-based theming without fighting a skin
  - Where: desktop-app 'the Rig' — foundation for T19 onboarding steps, T23 theme token packs, and chat composer/dialog primitives
  - Risk: Has a preinstall script (flagged install-scripts), audit before use; API still pre-2.0 and evolving
- **[irsyadadl/intentui](https://github.com/irsyadadl/intentui)** — MIT · pin `a0c02178f1b06f88cf83b0e60f5793e83fe97ec1` · ~15 h · fit: reference-only · ★1957
  - Why: React Aria Components + Tailwind meant to be copy-pasted, not installed as a dependency — matches our small/focused preference
  - Where: desktop-app 'the Rig' — T19 first-run onboarding modals/steps and composer input controls
  - Risk: Younger project (v3.x) with smaller community; copy-pasted components become ours to maintain
- **[elrumordelaluz/reactour](https://github.com/elrumordelaluz/reactour)** — MIT · pin `f38832ffd0b610e98dbed01d9dff6b058b1ec1a4` · ~8 h · fit: reference-only · ★4089 · flags: no-tests
  - Why: Purpose-built for guided first-run product tours — direct fit for T19 onboarding steps
  - Where: desktop-app 'the Rig' — T19 first-run onboarding step sequencing (pattern reference for our own lightweight tour)
  - Risk: Stale (last commit 2026-05-19), no tests, low scorecard (3.8) — use as a pattern reference, not a live dependency

## t22-t23-avatars-themes (T22/T23)

- **[chakra-ui/panda](https://github.com/chakra-ui/panda)** — MIT · pin `e917ab86b1b2285640ccd73550f8857973737c89` · ~24 h · fit: reference-only · ★6195 · flags: no-tests
  - Why: Type-safe, build-time CSS-in-JS token pipeline fits React/Tauri stack
  - Where: desktop-app 'the Rig' theme token build step (T23)
  - Risk: No test suite (flagged no-tests); v1 branch still active dev, API may shift
- **[lukasoppermann/design-tokens](https://github.com/lukasoppermann/design-tokens)** — MIT · pin `0acc078fb07a101910e0ab7a2870e1cf9814ffb9` · ~8 h · fit: reference-only · ★1126
  - Why: Exports DTCG/style-dictionary-compatible JSON usable as theme-pack source format
  - Where: design-token source-of-truth for T23 theme packs (Figma -> tokens.json)
  - Risk: It's a Figma plugin, not a runtime library — only the token schema/export convention is reusable
- **[crafter-station/petdex](https://github.com/crafter-station/petdex)** — MIT · pin `a1b229116968cbe9f3a9b2141634a9baa0819864` · ~6 h · fit: reference-only · ★4160 · flags: no-tests
  - Why: Public gallery pattern for versioned, signed animated avatars maps to T22's needs
  - Where: T22 signed avatar library structure/versioning convention
  - Risk: Built for CLI-agent pet avatars, not a pixel-sprite animation engine — no playback code to lift, just structure/inspiration

## t25-memory (T25)

- **[agentscope-ai/ReMe](https://github.com/agentscope-ai/ReMe)** — Apache-2.0 · pin `bebad3674573477ad294ca44eb15f508feea2665` · ~24 h · fit: reference-only · ★3525
  - Why: Purpose-built memory management kit ('Remember Me, Refine Me'), directly matches T25's store/recall/refine scope
  - Where: agent-core: new memory skill (skill.yaml) backing 'Remember this' for T25, storing facts per-user profile
  - Risk: Younger project (34 open issues on 3.5k stars); no independent audit of its retrieval/refine logic for correctness or leakage between memory entries
- **[EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS)** — Apache-2.0 · pin `462ebf9fd59b55c03fefb8eec855c62500f2a3cf` · ~30 h · fit: reference-only · ★13199
  - Why: Explicitly local-first, markdown-native, user-owned memory layer — matches 'no cloud' and per-person storage requirement closely
  - Where: agent-core: memory storage backend for T25, exposed via a review/delete UI in the Rig
  - Risk: 'Self-evolving' behavior across tools/workflows may conflict with agent-core's strict ask-first/append-only-log design and needs vetting against prompt-injection defenses before any pattern is reused
- **[Ar9av/obsidian-wiki](https://github.com/Ar9av/obsidian-wiki)** — MIT · pin `2f10142991344fe9526762e6f296594844c8477b` · ~12 h · fit: reference-only · ★3488
  - Why: Zero dependencies, small and focused — plain markdown 'digital brain' pattern is easy to audit line by line
  - Where: agent-core: reference for T25's memory file format/layout (per-fact markdown notes) rather than adopting code
  - Risk: Single-maintainer project with only 5 open issues tracked — low visibility into long-term maintenance or edge-case handling

## t28-permissions-policy (T28)

- **[apache/casbin-pycasbin](https://github.com/apache/casbin-pycasbin)** — Apache-2.0 · pin `b7c36d90dcd72fafd8cb0388d340f1788faf62d1` · ~24 h · fit: reference-only · ★1770
  - Why: RBAC/ABAC/ACL models with policies as external data files (CSV/JSON), matching 'ask-first rules as data' need
  - Where: agent-core: wrap enforcer around skill.yaml risky_steps + role gate for rag-pipeline; feed audit log from enforcer decisions into append-only log
  - Risk: Casbin's model/policy DSL is generic RBAC, not agent-tool-specific — will need a thin adapter layer mapping tool calls/plan hashes to Casbin subjects/objects/actions
- **[cloud-custodian/cloud-custodian](https://github.com/cloud-custodian/cloud-custodian)** — Apache-2.0 · pin `5217be4f33bcf29cdd8ebf2871107ede28eb5f64` · ~6 h · fit: reference-only · ★6073
  - Why: Mature YAML policy DSL for allow/deny + actions on resources, useful design reference for expressing ask-first rules as data
  - Where: Design reference for agent-core's skill.yaml risky_steps schema and policy evaluation flow
  - Risk: Built for cloud resource governance (AWS/Azure/GCP), not embeddable in-process; would require full rewrite to reuse any code, so only the design pattern transfers

## t29-feedback-loop (T29)

- **[Jwuthri/Tracely-ai](https://github.com/Jwuthri/Tracely-ai)** — MIT · pin `f332bc865d60cd4828dedf857bb58c15f388a045` · ~60 h · fit: reference-only · ★1361 · flags: no-tests
  - Why: MIT licensed and actively maintained (pushed 2026-09-23)
  - Where: agent-core: adapt clustering/freeze-to-test logic to build eval cases from thumbs-down entries in the append-only log; expose results to a weekly report job
  - Risk: No test suite of its own despite being a testing tool (flags: no-tests); is a full CI/CD framework, likely heavier than needed for just feedback->eval-case conversion, so expect to extract a subset rather than adopt wholesale

## t33-month-end-quickbooks (T33)

- **[routablehq/python-quickbooks](https://github.com/routablehq/python-quickbooks)** — MIT · pin `264a0f63d6336b006e77bfaadfe27131fa5607bd` · ~16 h · fit: reference-only · ★469 · flags: install-scripts
  - Why: MIT license, permissive and verified
  - Where: connectors repo, wrapped as a QuickBooks connector module feeding T33 month-end close skill in agent-core
  - Risk: Uses setup.py install scripts (flagged); pin exact commit and vendor/review before trusting in ask-first write flows
- **[IntuitDeveloper/SampleApp-QuickBooksV3API-Python](https://github.com/IntuitDeveloper/SampleApp-QuickBooksV3API-Python)** — Apache-2.0 · pin `c8f452a8c3e0a25509337f5ef2d1babc4180afe5` · ~3 h · fit: reference-only · ★53 · flags: no-ci, no-tests
  - Why: Official Intuit sample, Apache-2.0, actively updated (2026-09-17)
  - Where: connectors repo OAuth setup docs for T33, cross-check against Microsoft/Google OAuth patterns already in use
  - Risk: No CI/tests, sample-quality code only; do not import directly, just consult for flow correctness

## phase3-retrieval (Phase 3)

- **[run-llama/llama_index](https://github.com/run-llama/llama_index)** — MIT · pin `169e450aa54d26ed3e0536b1a0f1ea537871aa5d` · ~20 h · fit: reference-only · ★52322 · flags: no-tests
  - Why: MIT licensed and actively maintained with real adoption
  - Where: rag-pipeline (Phase 3 ticket) - ingestion/chunking/embedding stage
  - Risk: Large surface area, no visible test suite (flagged no-tests), risk of dependency bloat conflicting with mypy --strict / uv-managed Python 3.12 stack
- **[HKUDS/LightRAG](https://github.com/HKUDS/LightRAG)** — MIT · pin `4a319ecdc14f36446ae98b34952ab6719b2c322b` · ~30 h · fit: reference-only · ★39861 · flags: install-scripts
  - Why: Small, focused hybrid retrieval design (vector + lightweight graph/keyword)
  - Where: rag-pipeline (Phase 3 ticket) - hybrid search / retrieval scoring logic
  - Risk: Ships a setup.py install script (flagged); review before any packaging, and its scope (entity/graph extraction) exceeds what's needed for a simple drawer-doc search
- **[qdrant/qdrant](https://github.com/qdrant/qdrant)** — Apache-2.0 · pin `6ab21cac18ebb6f4ae29102c7f8f5cc11affd5de` · ~8 h · fit: drop-in · ★34827
  - Why: Apache-2.0, actively maintained, widely used vector search engine
  - Where: rag-pipeline (Phase 3 ticket) - local vector index/store behind the role-gated retrieval API
  - Risk: Core engine is Rust; local Python embedded mode is less battle-tested than the server mode, and adding it introduces a new storage dependency to keep in sync with agent-core's append-only logging

## scrubber-pii-secrets (remote scrubber)

- **[GitGuardian/ggshield](https://github.com/GitGuardian/ggshield)** — MIT · pin `259c1cfa43767e7bcf5bca55505c04746037c3c5` · ~10 h · fit: reference-only · ★1999
  - Why: MIT, actively maintained (commit today), 500+ secret detectors with live validation
  - Where: remote (pre-disk trace hook, alongside T28a prompt-injection suite)
  - Risk: Built for git-commit scanning workflows; needs wrapping to run against raw agent-trace strings rather than repo diffs
- **[Rizzo-AI-Academy/rizzo-pii](https://github.com/Rizzo-AI-Academy/rizzo-pii)** — MIT · pin `30d6f9c675e245bc8494df959adaeaa9d8de35c7` · ~15 h · fit: reference-only · ★1049
  - Why: MIT, local-first anonymization aimed exactly at 'don't send PII to an LLM' use case
  - Where: remote scrubber core (PII redaction pass before ggshield secret pass)
  - Risk: Newer/smaller project (1049 stars); license text and recall claims need manual verification before trusting for high-recall requirement
- **[maziyarpanahi/openmed](https://github.com/maziyarpanahi/openmed)** — Apache-2.0 · pin `6ff3809241dcb7df2a447da52e20d14dad65fe00` · ~40 h · fit: reference-only · ★5397
  - Why: Apache-2.0, very active, largest community (5397 stars) in local PII/PHI de-identification
  - Where: remote scrubber (recall-improvement reference for entity-based PII detection, not adopted wholesale)
  - Risk: Heavy: 2200+ medical models and Apple MLX dependency are overkill/mismatched for a lightweight trace scrubber; would need significant trimming to extract just the relevant NER recognizers

## agent-browser (agent browser)

- **[Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill)** — MIT · pin `147727a0e2ded65a7d0f364beea8cc2ebcdec8af` · ~24 h · fit: reference-only · ★7250 · flags: no-tests
  - Why: CLI + extension architecture cleanly separates browser automation from the main agent process, a useful isolation pattern for untrusted page content
  - Where: agent-core skills / future 'agent's own browser' ticket
  - Risk: Its 'don't interrupt your work' framing implies acting without confirmation, which conflicts with OASIS's ask-first preview model; no test suite to verify safety claims
- **[browserwing/browserwing](https://github.com/browserwing/browserwing)** — MIT · pin `051e68bd0bd1d358b785a2da74dbc1fecb85884e` · ~40 h · fit: reference-only · ★1415 · flags: no-tests
  - Why: Converts browser actions into constrained MCP commands instead of raw script execution, a natural fit for a tool-call model with ask-first previews
  - Where: agent-core tools + connectors, future browser tool ticket
  - Risk: No automated tests, so command safety/sandboxing claims are unverified; needs our own review before trusting it as an extension-to-agent bridge for untrusted pages
- **[Castor6/tactus](https://github.com/Castor6/tactus)** — Apache-2.0 · pin `b055ceffa947ef98a18652e49459ea795276701a` · ~24 h · fit: reference-only · ★375 · flags: install-scripts, no-tests
  - Why: First browser AI agent extension with an Agent Skills system, directly parallel to agent-core's skill.yaml/risky_steps design
  - Where: agent-core skills schema (skill.yaml), future browser skill ticket
  - Risk: Low activity signal (only 1 open issue, smaller community) and a postinstall install script flagged as a supply-chain risk if ever executed

## voice (T18 follow-ups)

- **[KoljaB/RealtimeSTT](https://github.com/KoljaB/RealtimeSTT)** — MIT · pin `777727553eedfa19aead15337ce66bab549add3f` · ~16 h · fit: reference-only · ★10147 · flags: install-scripts
  - Why: Combines low-latency STT with built-in VAD and wake-word support
  - Where: agent-core: new local voice-input service exposed over WebSocket to desktop-app 'the Rig' (T18 follow-up)
  - Risk: Heavy deps (torch/whisper models) and setup.py install script need auditing before use; resource-heavy for a lightweight desktop coworker app
- **[amsehili/auditok](https://github.com/amsehili/auditok)** — MIT · pin `7adf4bc1ed9afff637b8b8b9b2b24e72a1afa7ac` · ~3 h · fit: drop-in · ★860
  - Why: Small, focused, tested VAD/audio-segmentation library
  - Where: agent-core or Rig audio capture layer: gate mic input before sending to STT (T18 follow-up)
  - Risk: VAD only, no transcription; still need a separate STT engine to complete the pipeline
- **[k2-fsa/sherpa-ncnn](https://github.com/k2-fsa/sherpa-ncnn)** — Apache-2.0 · pin `c61e50d61e9fbed5972afa4d95bc560e168affe2` · ~32 h · fit: reference-only · ★1785 · flags: install-scripts, no-tests
  - Why: Fully offline real-time ASR + VAD, no internet dependency
  - Where: agent-core: alternative offline voice pipeline if OS speech-to-text proves insufficient (future T18/voice ticket)
  - Risk: No test suite (flagged), C++/ncnn bindings add build complexity and packaging burden for the desktop app

## packaging-updater (Rig update path)

- **[theBGuy/GitDesktop](https://github.com/theBGuy/GitDesktop)** — Apache-2.0 · pin `073c5e649bb81133721e598e35a0d5b043fb5a34` · ~12 h · fit: reference-only · ★228
  - Why: Same stack: Tauri 2 + React, with working self-update already shipped
  - Where: desktop-app "the Rig" auto-update ticket (signed updates + release config)
  - Risk: 52 deps and unrelated git/PR features could pull in scope creep if code is copied wholesale instead of just the updater config
- **[Wangnov/Codex-App-Manager](https://github.com/Wangnov/Codex-App-Manager)** — MIT · pin `f6ae7595cc8717dfda4df19065b66ac45cdb8a83` · ~6 h · fit: reference-only · ★514 · flags: no-tests
  - Why: MIT license, permissive and simple to reuse
  - Where: desktop-app "the Rig" Windows+macOS installer/uninstall flow
  - Risk: No test suite, unclear whether it's Tauri-based, and its China-mirror self-update endpoint is irrelevant/undesirable and must not be copied verbatim

## audit-observability (audit log)

- **[raga-ai-hub/RagaAI-Catalyst](https://github.com/raga-ai-hub/RagaAI-Catalyst)** — Apache-2.0 · pin `ab67893310891140211280a496402003e52cdab5` · ~24 h · fit: reference-only · ★16164
  - Why: Mature tracing schema for agent/LLM/tool spans (who/what/model) usable as a pattern for agent-core's append-only log
  - Where: agent-core append-only audit log module (supports T28a prompt-injection test suite need for traceable tool calls)
  - Risk: SDK is built around its own (possibly cloud/self-hosted) dashboard and 38 deps with telemetry; must verify no default phone-home before reusing any code, given local-first/privacy requirement
- **[future-agi/future-agi](https://github.com/future-agi/future-agi)** — Apache-2.0 · pin `ec05d596da5627bf844cc22640790a2f85d6a48b` · ~60 h · fit: reference-only · ★2077 · flags: no-tests
  - Why: Very recently active, broad feature set (tracing, evals, guardrails) could inspire cost/model-tracking fields
  - Where: remote trace/PII-scrubber design ideas; not integrated into any repo directly
  - Risk: No test suite and 975 open issues signal instability/maintenance debt; full platform is far larger than OASIS's focused local logging need
