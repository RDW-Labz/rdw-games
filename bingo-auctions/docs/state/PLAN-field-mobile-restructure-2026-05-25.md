# Plan — field-mobile restructure + lifecycle worklist + checkout fixes (2026-05-25)

**Source of truth for the other coding session.** Supersedes the inline plans in chat. Captures decisions from 2026-05-25 chat session with Michael + 6 read-only agent investigations.

---

## Final tab structure

```
(staff)/index.tsx — tile hub = effective tab bar

├── Lotting        ← creates lots from items in hand
│   ├── Quick Lot (barcode → fast save)
│   ├── AI Photo Scan
│   └── Web Lookup is EMBEDDED inside Quick + Photo review (not a tile)
│
├── Put-away       ← lots already exist, place them in bins
│   ├── Single Put-away          (intake/move/no-op all supported)
│   ├── Batch Put-away
│   └── Shelf-Scan + Put-away    (rewritten — see W3)
│
├── Worklist       ← (renamed from Inventory) field staff + manager to-do
│   ├── On shelf                 (current inventory browse)
│   ├── Needs re-lot             (unsold, retries remaining)
│   ├── Forfeited returns        (no-show / missed pickup window)
│   └── Flagged for disposal     (exhausted re-lot attempts)
│
├── Layout         ← now also owns bin QR codes
│   ├── Warehouse walk
│   ├── Bin landmarks
│   └── Bin QR codes (was /bins/)
│
└── Checkout       ← see W6 for fixes (P0 + P1)
```

**Removed:** import-review (manager work, lives on web only), UPC/Type link (legacy), standalone Web Lookup tile.

---

## Decisions locked

| ID | Decision | Why |
|---|---|---|
| **D1** | Lotting + Put-away are SEPARATE top-level tabs | Different workers, different workflows; never bundled in UI |
| **D2** | Shelf-Scan rewritten as **put-away of already-lotted items** (not AI lotting) | Current AI-photo lotting capability is duplicative of Quick Lot + Photo Scan |
| **D3** | Worklist tab surfaces three lifecycle states needing action | Re-lot, forfeit, disposal — none have manager UI today |
| **D4** | **No AI pricing on starting bid.** Default $1 (already `DEFAULT 100` in schema); editable in review tab | "I dont want quicklot having to call AI" |
| **D5** | **Add `lots.reserve_cents BIGINT NULL`** — future-proof, not active yet | Future reserve-price feature |
| **D6** | **Global uniqueness preserved via operator-prefix on physical sticker codes** | Even with collision-proof UUIDs today, add belt-and-suspenders + enable LPN-as-pre-sticker safely. See W2-bonus |
| **D7** | `intake_lot_to_bin` keeps accepting both `pending_intake` + `in_inventory` | Supports intake/move/no-op outcomes (per UX polish memo from other session) |
| **D8** | Load picker is manager-controlled; field-mobile is read-only | "field people should not be able to edit/mess that up easily" |
| **D9** | Operator-configurable rules go on `operators` table as typed columns | Established pattern (0097, 0113, 0122) |

---

## Workstreams

### W1 — Field-mobile tab restructure (mechanical)

22 file refs to update. Agent gave the complete checklist. **No Maestro tests touched, no deep links, no operator-web cross-links.**

| From | To |
|---|---|
| `picker/` directory | `put-away/` |
| `picker/intake.tsx` | `put-away/single.tsx` |
| `picker/batch-put-away.tsx` | `put-away/batch.tsx` |
| `picker/shelf-scan.tsx` | `put-away/shelf-scan.tsx` (rewritten — W3) |
| `bins/` directory | `layout/bins/` |
| `inventory/` directory | `worklist/` |
| Tile labels on `(staff)/index.tsx` | "Picker"→"Put-away"; "Inventory"→"Worklist"; "Bin QR codes" tile moves from Put-away hub to Layout |

### W2 — Lotting tab cleanup

| Change | Where | Why |
|---|---|---|
| **Drop import-review from mobile** | Delete `lotting/import-review.tsx`; manager flow stays on operator-web | Back-office task, not field |
| **Embed Web Lookup inside Quick + Photo review** | Add "Try web lookup for missing data" button in `ConfirmationCard` (quick.tsx) and `EditableCandidateCard` (photo.tsx) | Removes standalone tile from hub |
| **Promote `lots.source` (freeform) → structured Load picker** | New `loads` table on operator-web; field-mobile reads-only | Field staff can't edit/mess up loads |
| **"N lots from this load" counter** | New `useLoadLotCount(loadId)` hook on Lotting hub | Truck profit tracking |
| **Remove `useAiPricer` toggle entirely** | `SessionContext.tsx`, hub `SessionSheet`, `EditableCandidateCard` | Default $1 starting bid; operator edits as plain text |
| **Add Reserve Price field (future-proof)** | `EditableCandidateCard` adds nullable reserve input; persists to `lots.reserve_cents` | Bidding logic doesn't enforce yet; field-only for now |
| **Remove UPC/Type entry points** | scan.tsx UPC tab + hub link at `index.tsx:185-189` | Legacy |
| **Keep 2 sticker-binding modes: Generate QR / Pre-stickered** | `LottingModeContext.tsx` unchanged | Mode C (LPN-in-`lot_code`) dropped per D6 |
| **NEW Mode C** (post-W2-bonus): **Use LPN as physical sticker** | Surface as third mode in `LottingModeToggle`; writes `lots.sticker_code = {operator.code}:{LPN}` | Safe via operator-prefix |
| **`scan.tsx` photo tab consolidates** | Delete its custom photo flow; the "Photo" tab pushes to `/lotting/photo` | Eliminates duplication |
| **Fix `import-review.tsx` sticker gap** | Add `PreStickeredScanner` mount + `useLottingMode` import | Web-imported lots in prestickered mode silently skip the sticker bind today |

### W2-bonus — Global sticker uniqueness via operator-prefix (DB)

| Change | Detail |
|---|---|
| Add `lots.sticker_code TEXT` with global UNIQUE partial index | Format: `{operators.code}:{raw}` — e.g. `RDW:550e8400-e29b-41d4-a716-446655440000` or `RDW:LPNABC123` |
| Keep `lots.qr_token UUID` as-is | Backward compat; existing pre-stickered lots unchanged |
| Update `claim_prestickered_qr` RPC OR add `claim_sticker_code(p_lot_id UUID, p_raw_code TEXT)` | Server-side prefixes raw code with `current_operator_id()`'s `operators.code` before storing |
| Update `intake_lot_to_bin` to resolve by `lot_code` ∪ `qr_token` ∪ `sticker_code` | All three guaranteed unique (lot_code globally, qr_token UUID-globally, sticker_code globally via operator-prefix) |
| `lot_sticker_pool` updates | New rows for pre-printed UUID stickers store `sticker_code = {operator.code}:{uuid}` going forward; old rows untouched |

**Cross-operator collision impossibility:** `operators.code` is globally unique (CHECK constraint in `0021_inventory_lot_codes.sql:66-68`), so `{operators.code}:*` is globally unique by construction. Works for UUIDs, LPNs, or any other operator-chosen physical sticker scheme.

### W3 — Shelf-Scan rewrite (put-away of EXISTING lots)

| Current | Rewrite |
|---|---|
| Takes a photo of a shelf, AI identifies items, creates new lots | Continuous barcode scanner that resolves each scan against `lots.lot_code` / `qr_token` / `sticker_code` |
| Per-item feedback only on `done` screen | Live per-item ✓/✗ row list during scanning |
| Calls `create_draft_lot` | Calls NOTHING during scan (just resolves); bin-scan commits all via `batch_intake_lot_to_bin` |
| Silent if AI returns nothing | Explicit "this code didn't match any lot — switch to Lotting first" per row |
| Bridges to `batch-put-away` with `?preload=` param | Lives in its own screen end-to-end; no cross-screen handoff |

AI-photo lotting capability is NOT lost — Quick Lot and `lotting/photo.tsx` already cover it.

### W4 — DB: split intake RPC, keep status-flex

| RPC | Resolves on | Used by | Status accepted |
|---|---|---|---|
| **`intake_lot_to_bin`** *(tightened resolution, keep status flex)* | `lot_code`, `qr_token`, `sticker_code` ONLY (drop LPN/FNSKU/ASIN/external_code/legacy_lot_code fall-throughs) | Single Put-away, Batch Put-away, new Shelf-Scan | `pending_intake` OR `in_inventory` (supports intake/move/no-op) |
| **`lot_from_manifest`** *(new)* | LPN/FNSKU/ASIN/UPC/external_code/MPN against `import_rows` | Lotting tab only (Quick Lot scan path) | n/a |

Putaway scanning an un-lotted item returns `not_lotted_yet — go to Lotting first` instead of silently minting from manifest. Closes a class of silent-fail bugs.

### W5 — Worklist tab (rename Inventory; surface lifecycle)

| Section | SQL filter | Today |
|---|---|---|
| **On shelf** | `lots WHERE status='in_inventory'` | Exists (current inventory page) |
| **Needs re-lot** | `lots WHERE status='unsold' AND relist_count < operators.auto_relist_max_attempts` sorted oldest-first | Data exists; **no UI yet** |
| **Forfeited returns** | `pickups WHERE status IN ('no_show','forfeited')` OR `invoices WHERE status='unpaid_no_show'` | Data exists; **no staff worklist UI yet** |
| **Flagged for disposal** | `lots WHERE flagged_for_disposal=true` | **Column doesn't exist; needs migration** |

DB additions in new migration:
- `lots.flagged_for_disposal BOOLEAN DEFAULT FALSE`, `lots.flagged_at TIMESTAMPTZ`, `lots.flagged_reason TEXT`
- Cron extension to `auto_relist_unsold_lots`: when `relist_count >= operators.auto_flag_disposal_at_strikes`, set `flagged_for_disposal=true`
- New `mark_lot_disposed(lot_id, reason)` RPC for staff/manager action

### W6 — Checkout fixes (P0 + P1)

| Priority | Fix | Where |
|---|---|---|
| **P0** | Block premature pickup — `assign_lot_to_bin` RPC must require `lots.status='won'` before staging | Migration: replace `0005/0006` staging RPC with a status guard |
| **P0** | Incomplete pickup warning — `staff_confirm_pickup` RPC must compare submitted codes against all `invoice_lots` and surface missing | `0079` + `pickup-verify.tsx:383` |
| **P1** | Make bin-scan MANDATORY (remove manual checkbox bypass) | `pickup-verify.tsx:592-596` |
| **P1** | Wrong-customer detection — "Scan unknown item" mode: scan any lot QR during handoff → look up invoice → alert if not this invoice | New flow in `pickup-verify.tsx` |
| **P1** | Staging photo upload retry — move into RPC or add backoff | `stage.tsx:114-127` |
| **P1** | Queue 200-invoice silent truncation — move filter server-side | `queue.tsx:44` |
| **P2** | Refund photo capture for "item not as described" — upload to existing `dispute-evidence` bucket | New UI in `RefundButton` / `ResolveDisputeForm` |
| **P2** | Wire signature canvas (currently stub) | `pickup-verify.tsx:672-695` |

### W7 — Quick Lot Done-lag fix (perf)

Same 4 fixes — ~500ms restored:
- `persistence.ts:113` — parallel `resolveCategoryId`
- `SessionContext.tsx:182-217` — move AsyncStorage write out of updater
- `quick.tsx:564` — fire-and-forget `compressForVision`
- `quick.tsx:312-317` — `router.back()` first, deferred state cleanup via `InteractionManager.runAfterInteractions`

### W8 — Operator-configurable rules (additive `operators` columns)

| New column | Default | Range |
|---|---|---|
| `auto_charge_grace_hours` | 48 | 1–168 (replaces hardcoded 48h in `0105`) |
| `auto_flag_disposal_at_strikes` | 5 | 1–50 |
| `no_show_forfeit_threshold` | 3 | 1–20 |
| `pickup_grace_extension_hours` | 0 | 0–168 |

UI in `/settings` matching `AutoRelistForm.tsx` pattern + `saveSettings` Zod schema.

### W9 — Operator-web import UI clarity + Loads manager

| Route | Label | Imports to |
|---|---|---|
| `/imports/manifest` | **"Import manifest"** | `import_rows` pool — regular flow |
| `/imports/migrate` | **"Migrate inventory"** (NEW UI for 0137) | `lots` directly with preserved codes |
| `/loads` | **"Loads"** (NEW, manager-only) | `loads` table — auto-created from imports + manually created when buying unmanifested trucks |
| ~~`/lots/import`~~ | Delete (old CsvImportForm) | — |

### W10 — Move-confirmation UX (intake outcome distinction)

**Real-world driver:** customers (or other workers) physically move items in the warehouse and put them down somewhere else. When a field worker scans that lot to put it away in a NEW bin, the UI must show that the lot is already somewhere AND ask whether to move it.

Three outcomes the RPC supports today but the UI does not differentiate:

| Outcome | When | New UI |
|---|---|---|
| **Fresh intake** (`pending_intake` → `in_inventory@BinX`) | First time the lot is placed | "Intaked into BinX" — standard success toast |
| **Move** (`in_inventory@BinA` → scan to BinB) | Lot already put away; worker scans into a different bin | **Modal/sheet: "This lot is in BinA. Move to BinB?"** with Yes/No. Yes performs the move; No cancels and dismisses the scan |
| **Same-bin re-scan** (`in_inventory@BinA` → scan to BinA) | Lot already in this exact bin; harmless duplicate | "Already in BinA — already put away here" — info toast (NOT warning) |

| Change | Where |
|---|---|
| Capture from-bin BEFORE `UPDATE` overwrites `intake_bin_id` | `intake_lot_to_bin` RPC body |
| Return distinct return codes — `ok_intaked` / `pending_move` / `ok_already_here` — and bin info for the move case | RPC return shape |
| New "confirm move" client flow on `pending_move` — shows the modal, calls a follow-up RPC `confirm_move_lot_to_bin(p_lot_id, p_bin_qr_token)` only after user taps Yes | `put-away/single.tsx`, `put-away/batch.tsx`, `put-away/shelf-scan.tsx` |
| Branch `REASON_MESSAGES` on the new codes | same files |

**Already-shipped pieces (per the other session's status):** `b10-scan-pause` OTA already handles the camera-loop bug. Task #90 is the open marker for this UI work. Memory note `auction_platform_intake_move_ux_polish.md` in the other session's project captures the technical detail.

### W11 — Reserve price column (future-proof, no behavior change yet)

| Change | Detail |
|---|---|
| Add `lots.reserve_cents BIGINT NULL` migration | NULL means "no reserve" |
| Add to `EditableCandidateCard` review tab | Optional input next to Starting Bid |
| Persist via existing `create_draft_lot` RPC (add `p_reserve_cents BIGINT DEFAULT NULL`) | No bidding logic enforcement yet |
| Document in `lots` column COMMENT: "Future reserve-price floor. Not enforced by bidding RPCs as of W11. See follow-up workstream for enforcement." | Avoids confusion |

---

## What's NOT in scope (deferred)

- Reserve-price ENFORCEMENT in `place_bid` / `finalize_lot` (column only added now; logic later)
- Real-time pickup-ready notifications to bidder phones (separate feature)
- Operator analytics dashboards for re-lot rates (post-launch)
- LPN-as-`lot_code` (Mode C in `lot_code` column) — replaced by LPN-as-`sticker_code` via W2-bonus

---

## Sizing

| WS | Effort | Risk |
|---|---|---|
| W1 tab restructure | 1 medium PR — mechanical | Low |
| W2 Lotting cleanup (8 sub-items) | 2 medium PRs | Low |
| W2-bonus Sticker uniqueness via operator-prefix | 1 medium PR (DB + RPC) | Medium |
| W3 Shelf-scan rewrite | 1 medium PR | Medium (behavior change) |
| W4 Intake RPC split (status-flex preserved) | 1 medium PR + dual-deploy | Medium |
| W5 Worklist tab + flag-for-disposal | 1 large PR (new tab, 3 list views, migration, cron extension) | Medium |
| W6 Checkout fixes (P0 first, then P1) | 2 medium PRs | **Medium-High** — P0 is money risk |
| W7 Quick Lot lag | 1 small PR | Low |
| W8 Operator config (4 cols + UI) | 1 medium PR | Low |
| W9 Import UI rename + loads page | 1 medium PR | Low |
| W10 Intake outcome distinction | 1 small PR (RPC + 3 UI branches) | Low |
| W11 Reserve column (no logic) | 1 small PR (migration + form input) | Low |

**Critical path estimate: ~3–4 weeks total. ~1 week for W4+W6 P0 (the money-loss closers).**

---

## Resolved decisions (was open questions)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Loads UI: ONE combined `/loads` page** with a `type` column ("auto-import" / "manual") + filter chip | Less navigation for managers; both kinds answer the same question ("what trucks have I bought lately") |
| 2 | **Reserve column added now; UI input hidden behind `operators.reserve_pricing_enabled BOOLEAN DEFAULT FALSE` feature flag** | Operators opt in when enforcement ships. Until then, no operator confusion about "I set a reserve, why did the lot sell below it?" |
| 3 | **W10 same-bin re-scan: single info toast, not progressive feedback** | Per Michael's clarification, the real UX driver is the MOVE prompt for different-bin re-scans. Same-bin is harmless duplicate, no escalation needed |

---

## Source material

- Decisions captured 2026-05-25 chat session with Michael
- Code verification: 6 agent investigations (lotting features, picker/bins, quick-lot lag, lot lifecycle, checkout, lot_code uniqueness, operator config)
- UX polish absorbed: `~/.claude/projects/C--Users-jmacl-Projects/memory/auction_platform_intake_move_ux_polish.md` (other session's memory note)
- Repo state as of commit `0bbda01` (master, 2026-05-25)
- Companion docs: `docs/state/HANDOFF-taxonomy-v2-2026-05-24.md`, `docs/state/AUDIT-bugs-and-optimizations-2026-05-24.md`
