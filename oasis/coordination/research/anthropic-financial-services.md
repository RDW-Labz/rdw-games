# anthropics/financial-services — evaluation

**Verdict: reference only.** Apache-2.0, active, official Anthropic repo, well-built patterns — but it is a Claude-Cowork-plugin / Managed-Agents repo aimed at investment banks and funds, wired to 11 paid market-data MCPs (Daloopa, FactSet, LSEG, S&P Global, Moody's, PitchBook, etc.), none of which Cluer Holdings has or needs. Nothing here is a drop-in for `agent-core`'s skill.yaml runner. Two pieces are worth adapting as patterns for Amber/Michael; everything else is skip.

Source: https://github.com/anthropics/financial-services (read via `gh api`, no clone/run/login).

## 1. What it contains

- `plugins/agent-plugins/*` — 10 self-contained Cowork agent plugins (pitch-agent, meeting-prep-agent, market-researcher, earnings-reviewer, model-builder, valuation-reviewer, **gl-reconciler**, **month-end-closer**, statement-auditor, kyc-screener). Each = system prompt (`agents/<slug>.md`) + bundled skills.
- `plugins/vertical-plugins/*` — 6 skill/command/connector bundles by FSI vertical (financial-analysis [core, all 11 connectors], investment-banking, equity-research, private-equity, fund-admin, operations). Slash commands like `/comps`, `/dcf`, `/lbo`, `/ic-memo`.
- `plugins/partner-built/{lseg,spglobal}` — partner MCP-tool wrappers (bond RV, FX carry, tear sheets) — needs LSEG/S&P Capital IQ subscriptions.
- `managed-agent-cookbooks/*` — one dir per agent: `agent.yaml` (deploy manifest for Claude Managed Agents API), `subagents/*.yaml` (reader/critic/resolver leaf workers), `steering-examples.json`, README with a security tier.
- `claude-for-msft-365-install/` — admin tooling to provision the Claude M365 add-in against your own cloud (Vertex/Bedrock/internal gateway). Not a Cowork or Managed-Agent piece.
- `scripts/` — `check.py` (manifest linter), `validate.py`, `orchestrate.py` (reference event loop for `handoff_request` routing), `deploy-managed-agent.sh`, `sync-agent-skills.py`, `version_bump.py`. No notebooks.
- README references a `claude-for-financial-advisors/` dir that was **deleted 2026-09-21 (#354, 4 days before this review)** — the link in the current README is stale; that content is gone.
- License: **Apache-2.0 repo-wide**, verified in root `LICENSE`. Checked two subfolders that might diverge (`plugins/partner-built/spglobal/LICENSE`, `financial-analysis/skills/skill-creator/LICENSE.txt`) — both Apache-2.0 too. No GPL/proprietary surprises.
- Paid-vendor dependency: **all 11 core MCP connectors are commercial** (Daloopa, Morningstar, S&P Global/Kensho, FactSet, Moody's, MT Newswires, Aiera, LSEG, PitchBook, Chronograph) plus Egnyte/Box for docs — README says outright "MCP access may require a subscription or API key from the provider." Product-tied to **Claude Cowork** and the **Claude Managed Agents API** (`/v1/agents`), i.e. Claude-only, not model-agnostic — conflicts with OASIS's model-switch requirement.

## 2. Maturity

- Stars: **37,496**. Forks: 5,428. Open issues: 222. No `releases`/`tags` (0 each) — versioned by commit only, no semver.
- Last push: **2026-09-21** (4 days before this review) — very active, official.
- 14 contributors, all with Anthropic-staff-pattern usernames (`mihilmy`, `cxyback`, `manar-ant`, `tobinsouth`, etc.) — maintained by Anthropic, not community.
- Has CI (`.github/workflows`), a `check.py` manifest linter run pre-commit, and per-agent security-tier docs. No visible test suite comparable to `pytest`.

## 3. What could help Amber/Michael

- **month-end-closer / gl-reconciler skills** (accruals, roll-forwards, variance commentary, break-tracing) — closest fit to Amber's ops reporting and Michael's financial overview, even without IB terminals: the *method*, not the data source, transfers.
- **The reader/critic/resolver subagent pattern** (`gl-reconciler` agent.md "Guardrails"): untrusted-document readers get **no MCP access and no write tools**; only a resolver subagent (which never sees raw outside content) can write; a **critic re-verifies each finding against trusted sources before it's reported**. This is a concrete, working instance of "tool results are data, not instructions" and "check with something that is not the model."
- **skill-creator** (bundled in financial-analysis) — a generic skill-authoring guide, no vendor lock-in.
- Everything else (pitch decks, comps/DCF/LBO, KYC, LSEG/S&P analytics) targets IB/PE/fund-admin workflows Cluer doesn't run.

## 4. Mapping into OASIS

| Piece | Treatment | Why |
|---|---|---|
| gl-reconciler / month-end-closer prompts | **Borrow pattern only** | Rewrite as `skill.yaml` + `SKILL.md` against QuickBooks/Square, not GL/subledger MCPs. `risky_steps` would be: posting any adjustment, sending the exception report externally — both `always_ask`; the recon/trace/draft steps are not risky (read + draft only). |
| Reader-has-no-write / critic-re-verify guardrail | **Borrow pattern** | Maps onto our "tool results are data" and "checker is not the model" rules — but OASIS already enforces this via ask-first gate + independent `checker` callable, so it's confirmation of our design, not new capability. |
| `managed-agent-cookbooks` `agent.yaml` / `callable_agents` subagent wiring | **Reference only** | Claude Managed Agents API is a different runtime than `agent-core`'s loop runner; no import path. |
| MCP connectors (all 11) | **Skip** | Paid vendors Cluer doesn't use; would violate "pin versions, never latest" cleanly since repo itself has no releases, but more importantly these are Claude-product-tied, not model-agnostic — against our modular-model requirement. |
| skill-creator | **Skip / reference** | Generic guidance already covered by our own `skills` format docs. |
| Cowork plugin format / M365 add-in installer | **Skip** | Wrong product surface — OASIS is its own desktop app + connectors, not a Cowork or M365-add-in deployment. |
| KYC screener, pitch-agent, valuation-reviewer, IB/equity-research/PE verticals, LSEG/S&P partner plugins | **Skip** | No Cluer use case (not a fund, bank, or advisory shop). |

No rule violations found in the reviewed prompts themselves (no secrets embedded, no auto-send/auto-post steps — every agent README states outputs are "staged for human sign-off" and "no ledger posting"). The risk is only if someone imported the *architecture* (Managed Agents / Cowork tool-gating) as our ask-first mechanism — that gating lives in tool-availability config and prompt text there, not in a runtime yes/no bound to a plan hash like our rule requires, so it must not be treated as equivalent.

## 5. Effort for top 2

1. **Reader/critic-not-the-model checker pattern → `skills` repo skill-authoring convention.** Small. It's a documentation/convention change (how we write multi-step skills with an independent checker step and least-privilege sub-tools), not new code. Fits Phase 0 ticket 9 (skill format) as a written pattern note, or the Phase 1 "learn loop" write-up.
2. **Month-end-closer-style variance/roll-forward skill, rebuilt against QuickBooks/Square.** Medium. Needs a real `skill.yaml` with `risky_steps`/`always_ask`, test fixtures against Cluer's actual chart of accounts, and a `checker` that compares totals (same shape as the `weekly-numbers-pull` example in `formats.md`). Fits Phase 1 "Do the work" stage (pulling numbers into a report) for Amber, reusable in Phase 2 for Michael's cross-venture rollups.
