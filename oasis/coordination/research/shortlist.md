# Open-source shortlist for OASIS (2026-09-25)

Source files: agent-core.md, connectors-rag.md, desktop-ui.md, agent-hands.md, univer.md, anthropic-financial-services.md (all in this folder). Licenses verified against LICENSE files by the researchers. Nothing is adopted until Braden says yes; each yes becomes a decision + ticket, pinned by version or commit.

Ranked by when it pays off (next tickets first).

| # | Pick | License | Use it for | Ticket | How |
|---|---|---|---|---|---|
| 1 | NVIDIA/garak + liu00222/Open-Prompt-Injection | Apache-2.0 / MIT | Ready-made prompt-injection attacks to seed our injection test suite | T28a (next after T27b) | Borrow the attack cases as test data; our own pytest runner |
| 2 | microsoft/agent-governance-toolkit | MIT | YAML approval-policy schema and injection evaluator, a model for standing permissions | T28 | Borrow the pattern; our gate stays ours (Yes bound to the plan hash) |
| 3 | gl-reconciler pattern (anthropics/financial-services) | Apache-2.0 | Readers of outside documents get no write tools; a second pass double-checks each finding | skills convention now | Write it down as a skill rule |
| 4 | month-end-closer workflow (same repo) | Apache-2.0 | Amber's month-end numbers report, rebuilt as our skill.yaml on QuickBooks | Phase 1 skills | Rebuild; posting/sending = always_ask |
| 5 | assistant-ui | MIT | React chat parts: streaming, tool-call cards | T19 rest | Borrow components where ours are thin |
| 6 | Presidio operators + detect-secrets plugins | MIT / Apache-2.0 | Stronger PII + secret detection in the trace scrubber | remote scrubber hardening | Compare against our 200-trace test first; Braden merges scrubber changes |
| 7 | huey + APScheduler | MIT / MIT | Local task queue + recurring jobs, no server | parallel tasks / scheduling | Dependency, pinned |
| 8 | browser-use + microsoft/playwright-mcp | MIT / Apache-2.0 | The agent's own browser | agent browser ticket | Dependency; page text stays untrusted |
| 9 | markitdown → chonkie → fastembed → sqlite-vec | MIT / MIT / Apache-2.0 / MIT-Apache | Local ingest → chunk → embed → store; role gate = metadata filter | Phase 3 rag-pipeline | Dependencies, pinned |
| 10 | k2-fsa/sherpa-onnx | Apache-2.0 | On-device speech-to-text for Windows (Mac uses the OS) | T18 Windows | Dependency |
| 11 | BongoCat (Rust side only) | MIT | Proven Tauri click-through/overlay patterns | orb upkeep | Reference only (orb already works) |
| 12 | Univer | Apache-2.0 core; real .xlsx/.docx is paid | A preview panel for agent-made reports | later, maybe | Reference; for real files use Graph/Sheets APIs + openpyxl |

Already built, so skip: python-o365/MSAL (our connectors already do Microsoft OAuth + refresh), eventsourcing (our append-only log works).
Rejected on license: Skyvern (AGPL), dagu (GPL), Remotion (source-available), Open WebUI (branding clause + CLA), GetStream chat (proprietary), OWASP AI Testing Guide (CC BY-SA).
