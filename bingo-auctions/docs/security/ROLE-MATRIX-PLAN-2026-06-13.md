# Staff Role Matrix — design & execution plan (2026-06-13)

Status: **PLAN — approved scope is "Full role matrix project" (user, 2026-06-13).**
Foundational discovery complete (RBAC map below is from a fresh `origin/master`
read). Implementation is phased; Phase 1 is pure-additive/inert.

## 1. Problem

Role gating today is **scattered and hardcoded**. The same decision ("who can
refund?") is duplicated across an RLS policy, an RPC, and an API route, each
with its own literal role list (`IN ('admin','manager')`,
`IN ('admin','manager','lead')`, `role !== 'admin'`). Adding the `lead` role
(mig 0202) required hunting down every such site. There is no single place that
answers "what can role X do?", no UI that shows it, and several sensitive
actions are ungated or gated only by "any staff."

This is a footgun for a multi-operator platform: a misplaced policy can let a
picker issue refunds or lock an admin out of settings, and we'd only find out in
production.

## 2. Current state (as built, `origin/master` @ ae4774c)

### Roles — `operator_user_role` enum
`admin`, `manager`, `picker` (0001) + `lead` (0202). **No `cashier`.**
The June-11 "cashier/lead" decision shipped as a single `lead` role.

### Enforcement primitives
- `current_operator_role()` / `current_operator_id()` — SECURITY DEFINER, read
  `operator_users` by `auth.uid()` (0002_rls.sql).
- `operator_audit_log` (0157) — `action_type, actor_user_id, target_id,
  before_state, after_state, reason_note`. Read-gated to admin+manager.
- `operator_policies` (0157) — refund window, no-show behavior, fees.

### Where roles are checked TODAY
| Action | Gate today | Where |
|---|---|---|
| Edit operator settings/policies | **admin** | settings/policies/actions.ts:56; operators RLS update 0002:94 |
| Invite / manage staff | **admin** (+AAL2) | api/staff/invite/route.ts:100; operator_users RLS 0002:109 |
| Publish/schedule auction | admin, manager | auctions/[id]/builder/actions.ts:51 |
| Cancel auction | admin, manager | RPC cancel_auction 0096:197 |
| Mark lot disposed | admin, manager | RPC mark_lot_disposed 0146:246 |
| Refund (in-window, per-lot) | admin, manager, **lead** | api/invoices/[id]/refund-items/route.ts:135 |
| Refund (outside window) | admin **+ super-admin email** | refund-items/route.ts:212 |
| View refund queue / audit log | admin, manager | RLS 0159:118, 0157:145 |
| Manual / offline checkout | **any staff** (audited only) | api/invoices/[id]/manual-checkout/route.ts:77 |
| Pickup scan / verify / signature | **any staff** | (staff)/checkout/pickup-verify.tsx |
| Mark paid offline | admin, manager (implicit operator edit) | invoices RLS 0002:221 |
| Suspend bidder | **likely ungated** | (no explicit gate found) |
| All operator-scoped reads (lots/bins/auctions/invoices) | any staff of that operator | `*_staff_all` RLS |

### Gaps found
1. No single source of truth — every gate re-lists roles.
2. `manual-checkout`, `pickup-verify`, `mark paid offline`, `suspend bidder`
   are "any staff" or ungated — a picker can do counter-money actions.
3. Audit coverage is good for refunds/no-show/policy/manual-checkout, but
   **inventory adjustments, auction publish/cancel, settings edits, staff
   changes, offline mark-paid** are NOT consistently audit-logged.
4. No in-app surface showing "who can do what" (operator can't reason about it).

## 3. Target design — capability layer (single source of truth)

Stop hardcoding role lists. Introduce **capabilities** (verbs), map
**role → capabilities** in ONE place, and have RLS, RPCs, and app routes all ask
the same question: *does this actor have capability C?*

### Role ladder (monotonic — each role ⊇ the one below)
| Role | Persona | Inherits | Adds |
|---|---|---|---|
| **picker** | warehouse floor | — | intake, put-away, lotting, pickup scan/verify/sign |
| **cashier** *(NEW — decision point, see §6)* | counter checkout | picker | take payment, manual/offline checkout |
| **lead** | shift supervisor | cashier | in-window refunds, sticker-skip override, wrong-customer handling |
| **manager** | operations | lead | auction publish/cancel, lot dispose, inventory adjust, refund queue + audit view, mark-paid-offline |
| **admin** | owner | manager | operator settings/policies, staff management, Stripe/payouts, **out-of-window refund override** |

Super-admin (platform `jmacluer@gmail.com`) stays a separate, email-pinned
cross-operator escalation — NOT a role-matrix capability.

### Capability catalog (initial)
`inventory.intake`, `inventory.putaway`, `inventory.lot`, `inventory.adjust`,
`inventory.dispose`, `pickup.verify`, `pickup.sign`, `pickup.manual_checkout`,
`checkout.take_payment`, `payment.mark_paid_offline`, `refund.in_window`,
`refund.override`, `auction.publish`, `auction.cancel`, `lot.edit_live`,
`bidder.suspend`, `settings.edit`, `policy.edit`, `staff.manage`,
`payouts.manage`, `audit.view`.

### Mechanism
- New table `operator_role_capabilities (role operator_user_role, capability
  text, primary key (role, capability))`, seeded with the matrix above. Data,
  not code → adding/moving a capability is one `INSERT`/`DELETE`, no migration
  of logic.
- `operator_role_can(p_capability text) RETURNS boolean` — SECURITY DEFINER,
  STABLE: `EXISTS (SELECT 1 FROM operator_role_capabilities WHERE role =
  current_operator_role() AND capability = p_capability)`. Mirrors the existing
  `current_operator_role()` style.
- TS twin `operatorCan(supabase, capability)` for app routes (reads via RPC), so
  operator-web + field-mobile ask the identical question.
- Optional per-operator overrides later (`operator_user_capabilities` grants/
  revokes) — deferred; the role table covers launch.

## 4. Why a table+function (not a bigger enum or per-site lists)
- One audited place to answer "who can X" → an operator settings page can render
  the live matrix and (later) toggle it.
- RLS, RPC, and both apps converge on `operator_role_can('refund.in_window')`
  instead of three drifting literal lists.
- Adding the future `cashier` role = seed its capability rows; no RLS/route edits.

## 5. Phased execution (each phase its own PR; money-gating phases reviewed before merge)

- **Phase 1 — additive infra (INERT, safe to ship immediately).**
  Migration: `operator_role_capabilities` table + seed + `operator_role_can()`.
  `operator_audit_log` already exists. Nothing reads `operator_role_can()` yet →
  zero behavior change. + `operatorCan()` TS helper (unused). Mirrors how PR-A1
  shipped policy infra inert. **This is the "start" deliverable.**
- **Phase 2 — converge existing gates onto capabilities (behavior-preserving).**
  Replace the hardcoded lists at the §2 sites with `operator_role_can(...)`,
  seeding the matrix so the *current* behavior is reproduced exactly (e.g.
  `refund.in_window` → {admin,manager,lead}). Diff-tested against the current
  matrix; no new allow/deny. Reviewed before merge (touches refund/settings).
- **Phase 3 — close the gaps (§2.2/§2.3).** Gate `manual_checkout`,
  `mark_paid_offline`, `bidder.suspend` to the intended capabilities; add audit
  rows for auction publish/cancel, inventory adjust, settings/staff changes.
  This DOES change behavior (tightens) → explicit review + the field-mobile OTA.
- **Phase 4 — operator-facing surface.** Settings → "Roles & permissions" page
  rendering the live matrix (read-only first; per-operator toggles later) +
  "Audit log" viewer for admin/manager.
- **Phase 5 (optional) — `cashier` role** if §6 is approved: seed its rows,
  add to the invite UI; no logic changes thanks to Phase 1–2.

## 6. Open decisions (need a call before Phase 2/5)
1. **`cashier` role?** Today `lead` = counter person with refund power. Do we
   want a distinct lower `cashier` (checkout/take-payment, NO refund) beneath
   `lead`? The June-11 ask said "cashier/lead" — likely one concept, but a
   2-tier counter (cashier vs lead) is common in auction houses. Default if
   undecided: keep `lead` only; add `cashier` in Phase 5 when needed (zero-cost
   by then).
2. **Manual checkout** — currently any staff. Tighten to `cashier`+ (Phase 3)?
   Recommended yes.
3. **Per-operator capability overrides** — needed at launch, or role-default
   matrix only? Recommended: matrix-only for launch; add overrides post-launch.

## 7. Risk notes
- Phase 2 rewires money-gating RLS/routes — a wrong seed row could let a picker
  refund or lock out an admin. Mitigation: Phase 1 ships the matrix seeded to
  EXACTLY reproduce today's behavior; Phase 2 is a pure indirection swap, diffed
  against §2; a DB regression test asserts each (role, capability) cell.
- `current_operator_role()` returns ONE role per user (LIMIT 1). If a user ever
  maps to multiple operator_users rows this is ambiguous — confirm 1:1 before
  relying on it platform-wide (it is today).
- Keep super-admin email escalation OUT of the capability table (it's a platform
  break-glass, not an operator role).
