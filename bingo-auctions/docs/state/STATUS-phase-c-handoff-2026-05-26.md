# Phase C handoff — what shipped, what's left (2026-05-26)

End-of-session snapshot for the field-mobile restructure plan in
`docs/state/PLAN-field-mobile-restructure-2026-05-25.md`. This session
took the plan from "all pending" to "Phase A applied to prod + most
of Phase B/C in flight or shipped".

## What shipped this session

### Phase A — DB foundation (applied to prod)

| Migration | Workstream | Prod-applied |
|---|---|---|
| `0140_lots_reserve_cents.sql` | W11 | ✓ |
| `0141_lots_sticker_code.sql` | W2-bonus | ✓ |
| `0142_fix_batch_intake_ambiguous_lot_code.sql` | parallel-session hotfix | ✓ (16:52Z 5/25) |
| `0142_split_intake_rpcs.sql` | W4 | ✓ |
| `0143_intake_outcome_codes.sql` | W10 | ✓ |
| `0144_operator_config_columns.sql` | W8 | ✓ |
| `0145_requalify_batch_intake_lot_code.sql` | W4-followup | ✓ |
| `0146_lots_disposal_flag.sql` | W5-DB | ✓ |
| `0147_w6p0_pickup_money_guards.sql` | W6-P0 | ✓ |
| `0130_mfa_trusted_devices.sql` | MFA WIP (unplanned) | ✓ (inert — empty table) |

All 10 migrations live on Supabase project `xgsujdzicnjenhqihovk`. The
0130 application was unintentional but harmless: the table is empty
and no code reads it yet. Leave it or `DROP TABLE mfa_trusted_devices
CASCADE` later — your call.

### Phase B — Mechanical (merged to master)

| PR | Workstream | State |
|---|---|---|
| #70 | W1 — directory rename (picker→put-away, inventory→worklist, bins→layout/bins) | Merged |

### Phase C — UI (in PR #71, awaiting CI + merge)

| Workstream | Scope shipped | Scope deferred |
|---|---|---|
| W7 | quick.tsx fire-and-forget `compressForVision` | 3 other plan refs were stale (resolveCategoryId, persistence.ts, router.back) |
| W10-UI | single.tsx full three-outcome modal (ok_intaked / ok_already_here / pending_move + confirm_move_lot_to_bin call); batch.tsx type + ERROR_LABELS widened | Per-row Confirm move in batch results screen |
| W5-UI | worklist/index.tsx renamed eyebrow + "Flagged" filter pill; useInventoryList hook supports `flagged` filter | "Forfeited returns" section (needs pickups+invoices hook) |
| W6-P1 | pickup-verify checkbox no longer accepts manual check (only un-check); hint copy updated | W6-P2 (refund photos, signature canvas, wrong-customer detection) |

Build marker bumped to `b11-restructure` (in W1).

## What's left from the plan

### Pending mobile (deserves clean-context session)

| Workstream | Why deferred | Effort |
|---|---|---|
| **W2 full** Lotting cleanup | Multi-file: drop `import-review.tsx`, remove `useAiPricer` from SessionContext, embed web-lookup button in ConfirmationCard + EditableCandidateCard, add Reserve Price input, add Mode C (LPN-as-sticker), remove UPC/Type tabs, consolidate scan.tsx photo tab | L |
| **W3 full** Shelf-scan rewrite | Full file replacement — current AI-photo flow → continuous-scan lot resolution + one bin commit via `batch_intake_lot_to_bin` | L |
| **W6-P2** | 4 items: refund photo capture, signature canvas, wrong-customer detection (scan-unknown mode), staging-photo retry, queue-200 server-side filter | L |

### Pending operator-web (zero worker risk — parallelizable)

| Workstream | Scope |
|---|---|
| **W9 slice 2** | NEW `/imports/migrate` UI for 0137 BinGo legacy migration (preserves source lot_codes) |
| **W9 slice 3** | NEW `loads` table + RLS + RPC + `/loads` manager-only page + auto-link imports → loads |

## How to ship the Phase C OTA

After PR #71 CI greens and the PR merges:

```powershell
cd C:\Users\jmacl\Projects\auction-platform
gh workflow run "EAS Update (OTA)" --ref master `
  -f app=staff -f branches=both `
  -f message="b11-restructure: W1 directory rename + W7 perf + W10-UI three-outcome + W5-UI flagged + W6-P1 mandatory bin scan"
```

Workers must force-quit + reopen TWICE to pick up the new bundle. The
build marker on the Put-away hub (NOT Picker anymore) should read
`b11-restructure`.

## Behavior changes workers will notice after OTA

1. **"Picker" tab is gone** — replaced by "Put-away" on the staff hub
2. **"Inventory" tab is gone** — replaced by "Worklist"
3. **Bin QR codes tile** is gone from Put-away hub — accessible at
   `/layout/bins` (no hub tile yet; URL or follow-up PR adds it)
4. **Same-bin re-scan** during put-away no longer silently re-stamps —
   shows "Already here" info alert
5. **Cross-bin scan** of an already-binned lot shows "Move this lot?"
   modal with from→to bin codes
6. **Un-lotted scans** now return `not_lotted_yet` instead of silently
   minting (W4 + UI copy)
7. **Pickup verification** no longer allows manual checkbox check —
   bin scan is required (W6-P1)
8. **Quick Lot Done** feels snappier (~100-200ms restored — W7)

## Recommended next-session approach

The remaining mobile rewrites (W2, W3, W6-P2) and operator-web W9
slices 2-3 are substantial. Each deserves clean context. Suggested
order:

1. **W9 slice 3** (loads table + page) — operator-web only, zero
   worker disruption, sets up `loads` foundation
2. **W9 slice 2** (`/imports/migrate` UI) — operator-web, can ship
   anytime
3. **W2** Lotting cleanup — biggest mobile rewrite but most polish
   value
4. **W3** Shelf-scan rewrite — depends on W4 RPCs (already prod)
5. **W6-P2** Checkout hardening — only matters once pickups start

## Migration tracking + verification

```powershell
cd C:\Users\jmacl\Projects\auction-platform
node scripts/apply-migrations.js --status
# All migrations through 0147 should show ✓
```

Smoke checks on prod:

```sql
-- W4/W10: tightened intake RPC
SELECT pg_get_functiondef('intake_lot_to_bin(text, uuid)'::regprocedure);

-- W10: confirm_move RPC exists
SELECT proname FROM pg_proc WHERE proname = 'confirm_move_lot_to_bin';

-- W5-DB: disposal column + index
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'lots' AND column_name = 'flagged_for_disposal';
SELECT indexdef FROM pg_indexes WHERE indexname = 'lots_flagged_for_disposal_idx';

-- W8: operator config defaults
SELECT auto_charge_grace_hours, auto_flag_disposal_at_strikes,
       no_show_forfeit_threshold, pickup_grace_extension_hours
  FROM operators WHERE code = 'BIN';

-- W6-P0: assign_lot_to_bin status guard
SELECT pg_get_functiondef('assign_lot_to_bin(uuid, uuid, text, text)'::regprocedure);
```

## Open follow-ups (small, post-OTA)

- Add a hub tile for `/layout/bins` to `/layout/index.tsx` (currently
  reachable only by direct URL)
- Per-row "Confirm move" tap-to-call in batch put-away results
- Worklist "Forfeited returns" section — needs separate hook (pickups
  + invoices)
- W2 sticker-binding Mode C UI surface in `LottingModeToggle`
