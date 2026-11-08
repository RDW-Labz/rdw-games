# Univer evaluation (dream-num/univer) — for Amber's admin work

**Verdict: try in a spike (narrow) — do not adopt for xlsx/docx round-tripping.**
Core SDK is genuinely Apache-2.0 and active, but the thing Amber needs most —
faithful real-file `.xlsx`/`.docx` import/export — is Pro-only and needs a paid
server. Use it, if at all, as an in-app preview surface for data the agent
already produced, not as our Office-file I/O layer.

## 1. License — core vs Pro
- Core repo `dream-num/univer`: **Apache-2.0**, verified against the actual
  `LICENSE` file (https://github.com/dream-num/univer). No CLA text found in
  `CONTRIBUTING.md`. A `packages/telemetry` package exists (Apache-2.0); README
  doesn't state default/opt-out status — unverified, flag it.
- **Open-core split matters a lot.** Per README's own "Open Source and Pro" table
  (https://github.com/dream-num/univer#-open-source-and-pro):
  - **Free**: sheet/doc model, formulas, number formatting, filter/sort, data
    validation, conditional formatting, hyperlinks, comments, find/replace,
    notes, tables, drawing, React/Vue/Web-Component adapters, Node headless.
  - **Pro (closed, `@univerjs-pro/*`)**: real-time collaboration, edit history,
    **import/export (xlsx/docx/csv/tsv/pdf)**, printing, charts, pivot tables,
    sparklines, server-side calculation, collaboration server, SSR.
  - Confirmed on docs.univer.ai/guides/sheets/features/import-export: xlsx
    import/export needs `@univerjs-pro/exchange-client` **and a conversion
    backend**. CSV/TSV export is single-sheet, no formatting. No free path to
    open a real customer `.xlsx` and hand it back byte-faithful.
  - `skills` repo's `univer-pro-integrate` SKILL.md calls Pro features
    "licensed"; no public price/key mechanics in the repo itself.
- Related repos, all Apache-2.0/MIT, no CLA seen: `dream-num/skills`
  (Apache-2.0, 70★, pushed 2026-09-01, active), `dream-num/univer-mcp` (MIT,
  38★, **last push 2025-09-06 — stale, >12mo**), `dream-num/univer-mcp-start-kit`
  (Apache-2.0, 23★, pushed 2025-11-27), `dream-num/univer-workspace`
  (Apache-2.0, 887★, pushed 2026-09-25, very active — but its Server "composes
  the Univer Collaboration SDK," i.e. leans on the Pro-adjacent layer).

## 2. The "AI agent harness" claim
- Core repo's new tagline ("Office Harness for AI Agents") points to **separate,
  smaller repos**, not the SDK itself:
  - `univer-mcp` — MCP server proxying calls into a Univer instance; MIT, 38★,
    no commits in ~a year — not maintained.
  - `univer-mcp-start-kit` — config examples to wire MCP clients to sheets;
    small, "start kit" maturity only.
  - `univer-workspace` — the mature one: deployable Browser+Server+Agent+CLI
    with a **Worktree model** (agent edits an isolated draft → Ready → human
    reviews → Merge/Reopen). Maps well onto our ask-first/plan-hash pattern,
    but it's a standalone server product, not a library to embed.
- Core repo: v1.0.0 as of 2026-09-23 (this week), 18.2k★, 1554 forks, 146 open
  issues, daily commits, real docs site (docs.univer.ai) — genuinely active.
  The agent-harness layer around it is new/thin by comparison.

## 3. Tech fit
- TypeScript; runs in browser and Node (headless) — could sit in a Tauri
  webview as an editor pane, and/or run under Node for Python agent-core to
  drive (needs a Node sidecar; cross-process, not in-proc).
- Round-trip fidelity: only its own snapshot/JSON format is fully free. Real
  `.xlsx`/`.docx` round-trip is Pro + server — a hard blocker for "open the
  vendor's actual Excel file and hand it back unchanged."

## 4. OASIS fit vs simpler alternatives
- Could win: an **in-Rig preview pane** for reviewing agent-proposed cell/doc
  edits before the Yes click, when data is already in Univer's own model
  (agent-generated dashboards/mini-apps — not customer .xlsx files).
- Overkill for: reading/writing Amber's real OneDrive/Drive files.
  `openpyxl`/`python-docx` (Python, fits agent-core) or Microsoft Graph Excel
  API / Google Sheets API do this today, free, in-process, no Pro license.

## 5. Risks
- **Bundle size**: full SDK+UI+adapters is heavy for a Tauri+React app, for a
  niche view.
- **Security**: rendering untrusted file content in a webview is a bigger
  attack surface than parsing bytes in Python — and moot since real files
  can't cleanly round-trip without Pro anyway.
- **Lock-in**: Univer's own document model becomes a second source of truth
  alongside the customer's real Office files.
- **Backing**: DreamNum Co., Ltd. (commercial company), OpenCollective
  funding; core is well-backed, but agent/MCP satellite repos are early and
  could be abandoned or folded into Pro.

Sources: github.com/dream-num/univer (README, LICENSE, DREAMNUM.md, packages/),
docs.univer.ai/guides/sheets/features/import-export, github.com/dream-num/
{univer-mcp, univer-mcp-start-kit, skills, univer-workspace}.
