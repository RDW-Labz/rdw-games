# Warehouse + Pickup Feature Redesign Plan

**Created**: 2026-05-20
**Source**: 3 parallel agent audits (UX operator+staff, UX bidder, architecture/data-model)
**Status**: planning complete, implementation deferred to next session
**Urgency**: Phase 0+1+2+3 must all land before Bingo's first live auction because **Bingo is operating in customer-pickup mode**, which requires a working bidder map + per-lot check-off + complete data-model support.

---

## Context

The warehouse layout feature was originally vibe-coded from scaffolding. The data model is mostly correct, but the feature surface has 7 active bugs, lacks the schema concept of "pickup mode," and has UI/UX problems that would frustrate operators and bidders in real use.

The user (Michael Cluer at ClovrBid / GOLD RUN LLC) confirmed:
- **First operator (Bingo) will use customer-pickup mode** — bidders walk the warehouse with a map and grab their items themselves. No staff staging.
- The platform must support BOTH customer-pickup AND staff-assisted modes (different operators will choose different models).
- Customers will need a real map (not just a list of bin codes) to find their items when self-picking.

This means the bidder-app pickup screen — currently a single layout that tries to be both modes — needs to split into two distinct mode-aware layouts, with **the floor-plan map being the hero element for customer-pickup**, supported by a per-lot check-off and a "Confirm pickup" action.

---

## Pre-launch goal

A new operator (Bingo or anyone) can:
1. Open the operator console at `clovrbid.com/warehouses` and follow a guided setup → create a warehouse, generate 200+ bins via bulk add, upload a floor plan, drag pins onto positions, print QR labels, set pickup hours, and choose pickup mode (staff-assisted vs customer-pickup).
2. Their staff app shows the warehouse layout and lets pickers scan bins during intake.
3. Bidders who win lots can:
   - **Staff-assisted mode**: pay → get a QR check-in code → show it to staff at counter → staff scans + brings items
   - **Customer-pickup mode**: pay → see a floor-plan map with their bin locations highlighted → walk the warehouse → check off each item as they collect it → tap "Confirm pickup" → done
4. The whole flow works for multiple operators simultaneously with RLS-enforced isolation.

---

## Phase 0 — Pre-launch bug fixes (~3 hrs, do first)

These are concrete bugs from the audit reports, not opinions. Each has a file:line citation, a repro path, and a fix sketch.

### BUG-001 — sketch.tsx double-scales coordinates
**File**: `apps/field-mobile/app/(staff)/layout/sketch.tsx` lines 66, 72-75, 246-252
**Symptom**: Saved shapes render at the wrong position on the canvas. Draft (in-progress) shapes are correct because they multiply by `scaleScreenToLogical`; committed shapes do NOT.
**Fix**: Store shapes in logical coordinates at commit time (the same conversion already done at save, lines 125-129) instead of in screen pixels. Remove the second multiplication in the saved-shapes block at lines 246-252.

### BUG-002 + BUG-009 — Server actions write through service-role without operator scope re-check
**Files**:
- `apps/operator-web/src/app/(operator)/warehouses/[id]/floorplan/actions.ts` lines 14 (`setFloorPlanMeta`), 40-51 (`moveBin`)
- `apps/operator-web/src/app/(operator)/warehouses/[id]/pickup-hours/actions.ts` lines 39-77 (`updatePickupHours`)
**Symptom**: Actions use `getSupabaseAdmin()` (service role, bypasses RLS) to UPDATE warehouse + bins rows. They rely on the implicit RLS check via the cookie-session SELECT earlier in the function, but if that check passes and the row state changes before the admin UPDATE fires, the write executes without operator-scope validation.
**Fix**: Either (a) add `.eq('operator_id', me.operator_id)` to every admin UPDATE explicitly, or (b) use the RLS-aware client for the UPDATE too. (a) is cleaner.

### BUG-004 — File uploads with `upsert: false` create orphaned storage objects
**Files**:
- `apps/operator-web/src/app/(operator)/warehouses/[id]/floorplan/FloorPlanEditor.tsx` lines 56-63
- `apps/field-mobile/app/(staff)/layout/floorplan-photo.tsx` line 94
- `apps/field-mobile/app/(staff)/layout/sketch.tsx` line 133
**Symptom**: Every "Replace floor plan" upload generates a new timestamped path with `upsert: false`. The previous file is never deleted. Over time, storage accumulates orphan PNG/JPEGs.
**Fix**: Either delete the previous `floor_plan_url` before uploading the new one, or change to `upsert: true` with a deterministic path (`{operator_id}/{warehouse_id}/current.png`).

### BUG-007 — Pickup hours day-of-week calc wrong at UTC midnight
**File**: `apps/operator-web/src/app/(operator)/warehouses/[id]/pickup-hours/page.tsx` lines 67-69
**Symptom**: `new Date(date.toLocaleDateString('en-US', { timeZone: tz })).getDay()` creates a Date from a localized date string without timezone information. The Date constructor then re-parses it in the server's timezone (typically UTC on Cloudflare Workers). For warehouses in non-UTC timezones, the preview shows the wrong day's hours during the hours that straddle UTC midnight.
**Fix**: Use `Intl.DateTimeFormat` with `weekday: 'short'` and `timeZone: tz`, then map the result to your day-key. Or use a date library (Luxon, date-fns-tz) that handles timezones natively.

### BUG-010 — Floor plan recorded width capped at 2048 but image uploaded full-res → bin pins land at wrong physical positions by up to 2×
**File**: `apps/field-mobile/app/(staff)/layout/floorplan-photo.tsx` lines 91-92
**Symptom**: The comment claims "auto-resize policy is enforced server-side" but no transform is configured. A 4032px iPhone photo is uploaded at full resolution, but `floor_plan_width_px` is recorded as 2048. The floor plan editor's `pageToImagePx` then computes coordinates using the 2048 dimension while the rendered SVG uses the actual 4032 image dimensions. **Bin pins drag to positions that physically point to wrong locations on the floor — up to 2× offset.**
**Fix**: Either (a) actually resize the image client-side before upload using expo-image-manipulator (which is already a dep), or (b) record the full original dimensions in `floor_plan_width_px`/`height_px` and ensure the editor uses the same values for its coordinate system.

### BUG (H7 regression) — confirm_pickup (migration 0079) dropped the operator_id cross-check
**File**: `packages/db/migrations/0079_staff_confirm_pickup_and_fix_confirm_pickup.sql` lines 72-164 vs `packages/db/migrations/0028_security_fixes.sql` lines 347-425
**Symptom**: Migration 0028 added an explicit `i.operator_id = bin.warehouse.operator_id` join to `confirm_pickup` to prevent cross-operator pickup confirmation. Migration 0079 rewrote `confirm_pickup` to fix a different bug (pickups never marked complete) but silently dropped the 0028 scope check. A bidder with paid invoices at operators A and B, scanning operator A's bin QR, could flip lots from operator B's invoices into a confirmed state.
**Fix**: Re-add the operator_id predicate in the rewritten function body. Test with a multi-operator bidder fixture.

### BUG — intake_lot_to_bin has no FOR UPDATE on lots; concurrent pickers can scramble assignments
**File**: `packages/db/migrations/0064_bin_token_rotation.sql` lines 240-249 (current implementation of intake_lot_to_bin)
**Symptom**: Two pickers scan the same lot label at the same instant. Both pass the `lot.status='pending_intake'` check. Both UPDATE without a lock. The second write overwrites the first's `intake_bin_id`. Picker 1 believes the lot is in bin A; picker 2 actually placed it in bin B.
**Fix**: `SELECT ... FROM lots WHERE id = p_lot_id FOR UPDATE` at the top of the function. Same pattern in `batch_intake_lot_to_bin`.

### BUG — bins_bidder_read RLS too permissive (competitive intel leak)
**File**: `packages/db/migrations/0002_rls.sql` lines 126-156
**Symptom**: `bins_bidder_read USING (is_bidder())` lets any signed-up bidder SELECT every operator's bins. Combined with `warehouses_bidder_read` which is similarly broad, a competitor can scrape complete warehouse layouts from the platform.
**Fix**: Scope to bins from operators where the bidder has at least one paid or pending invoice: `USING (is_bidder() AND warehouse_id IN (SELECT DISTINCT a.warehouse_id FROM auctions a JOIN lots l ON l.auction_id = a.id JOIN invoice_lots il ON il.lot_id = l.id JOIN invoices i ON i.id = il.invoice_id WHERE i.bidder_id = auth.uid()))`. Or simpler: only allow reads via a security-definer function that takes an invoice_id and returns just the bins relevant to that invoice's lots.

---

## Phase 1 — Migration 0094 (data model foundation)

File to create: `packages/db/migrations/0094_pickup_mode_and_lifecycle.sql`

```sql
-- Pickup mode: per-warehouse default, per-auction optional override
ALTER TABLE warehouses
  ADD COLUMN pickup_mode TEXT NOT NULL DEFAULT 'staff_assisted'
    CHECK (pickup_mode IN ('staff_assisted', 'self_serve', 'hybrid'));

ALTER TABLE auctions
  ADD COLUMN pickup_mode_override TEXT
    CHECK (pickup_mode_override IN ('staff_assisted', 'self_serve', 'hybrid'));

ALTER TABLE pickups
  ADD COLUMN pickup_mode TEXT;  -- recorded at completion for audit

-- Floor plan versioning + staleness tracking
ALTER TABLE warehouses
  ADD COLUMN floor_plan_version INT NOT NULL DEFAULT 1,
  ADD COLUMN floor_plan_uploaded_at TIMESTAMPTZ;

ALTER TABLE bins
  ADD COLUMN floor_plan_version_placed INT;  -- track which plan version this bin was positioned on
COMMENT ON COLUMN bins.floor_plan_version_placed IS
  'Set to warehouses.floor_plan_version at the time the operator dragged this bin onto the plan. If it lags the current warehouse version, the operator UI surfaces this bin as "stale — re-position".';

-- Coord bounds (defense-in-depth — bulk RPC + UI both produce coords, neither validates)
ALTER TABLE bins
  ADD CONSTRAINT bins_coords_nonneg CHECK (x_px >= 0 AND y_px >= 0);

-- Bin lifecycle: replace is_active (unenforced) with explicit retired_at
ALTER TABLE bins ADD COLUMN retired_at TIMESTAMPTZ;
COMMENT ON COLUMN bins.retired_at IS
  'When set, this bin is retired. RPCs that write to bin_assignments must reject retired bins. The QR token may still scan to allow cleanup of in-flight pickups, but no new assignments.';

-- Drop the unenforced is_active column (or keep + add policy enforcement; prefer drop to reduce dual sources of truth)
-- TODO: review existing usage of is_active before dropping. Migration plan TBD.

CREATE INDEX bins_active_retired_idx ON bins(warehouse_id) WHERE retired_at IS NULL;

-- Restore H7 cross-operator scope in confirm_pickup (REGRESSION FIX from 0079 dropping the 0028 fix)
CREATE OR REPLACE FUNCTION confirm_pickup(...)
RETURNS ... AS $$
-- (full body with operator_id join restored)
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Intake race fix: add FOR UPDATE to lots SELECT in intake_lot_to_bin + batch_intake_lot_to_bin
CREATE OR REPLACE FUNCTION intake_lot_to_bin(...)
RETURNS ... AS $$
DECLARE
  v_lot lots%ROWTYPE;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  -- existing logic continues with v_lot
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Tighten bins_bidder_read: only the bins relevant to the bidder's paid/pending invoices
DROP POLICY bins_bidder_read ON bins;
CREATE POLICY bins_bidder_read ON bins FOR SELECT TO authenticated
  USING (
    is_bidder() AND warehouse_id IN (
      SELECT DISTINCT a.warehouse_id
      FROM auctions a
      JOIN lots l ON l.auction_id = a.id
      JOIN invoice_lots il ON il.lot_id = l.id
      JOIN invoices i ON i.id = il.invoice_id
      WHERE i.bidder_id = auth.uid()
        AND i.status IN ('paid', 'pending', 'partially_refunded')
    )
  );

-- Same scope tightening for warehouses_bidder_read
DROP POLICY warehouses_bidder_read ON warehouses;
CREATE POLICY warehouses_bidder_read ON warehouses FOR SELECT TO authenticated
  USING (
    is_bidder() AND id IN (
      SELECT DISTINCT a.warehouse_id
      FROM auctions a
      JOIN lots l ON l.auction_id = a.id
      JOIN invoice_lots il ON il.lot_id = l.id
      JOIN invoices i ON i.id = il.invoice_id
      WHERE i.bidder_id = auth.uid()
        AND i.status IN ('paid', 'pending', 'partially_refunded')
    )
  );

-- New RPC: move_bin_contents(from_bin_id, to_bin_id)
-- For when an operator retires a bin and needs to relocate all its lots.
-- Atomic, audited via bin_assignments append-only history.
CREATE OR REPLACE FUNCTION move_bin_contents(p_from_bin UUID, p_to_bin UUID)
RETURNS INT  -- count of moved lots
AS $$
...
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- New RPC: ensure_pickup_row(invoice_id)
-- Idempotently create a pickups row when an invoice is paid. Walk-in operators
-- need this to enable QR code rendering on the bidder app.
CREATE OR REPLACE FUNCTION ensure_pickup_row(p_invoice_id UUID)
RETURNS UUID  -- the pickups.id (existing or new)
AS $$
...
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- New RPC: bidder_confirm_customer_pickup(invoice_id)
-- For customer-pickup mode. Flips all this bidder's lot assignments at this
-- invoice to 'picked_up', updates pickups row, enqueues pickup_confirmed
-- notification.
CREATE OR REPLACE FUNCTION bidder_confirm_customer_pickup(p_invoice_id UUID)
RETURNS jsonb  -- { ok, lots_confirmed, warnings }
AS $$
...
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

Then regenerate `packages/shared/src/database.types.ts` via `npx supabase gen types typescript --linked > packages/shared/src/database.types.ts`.

---

## Phase 2 — Operator-web warehouse setup hub

Replace the current three-link row (`/warehouses/[id]` → Bins, Pickup hours, Floor plan) with a single setup hub showing 5 phases with completion state.

### Page structure: `apps/operator-web/src/app/(operator)/warehouses/[id]/page.tsx`

```
Warehouse: Bingo Cincinnati Main
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[✓] Step 1 — Bins                  200 bins across 5 aisles  [Edit bins →]
[ ] Step 2 — Floor plan            No floor plan uploaded     [Upload →]
[ ] Step 3 — Position bins         (requires floor plan)
[ ] Step 4 — QR labels             Not printed                [Print sheet →]
[✓] Step 5 — Pickup hours          Mon-Sat 10:00-17:00        [Edit →]
[✓] Step 6 — Pickup mode           Customer pickup            [Change →]
```

### Sub-page changes

**`/[id]/bins/page.tsx + BinForm.tsx`**:
- Live preview in bulk-add: "Will create 60 bins: A-01-1-01 through A-10-3-02"
- "Skip existing codes" checkbox
- Post-create summary toast: "60 bins added. 0 already existed. [Print QR sheet →]"
- Per-row actions in the bins table: edit, retire, rotate QR, view QR
- Search/filter when bin count > 50

**`/[id]/floorplan/page.tsx + FloorPlanEditor.tsx`**:
- Position counter: "48/200 bins positioned"
- Unpositioned bins pulse grey; positioned solid blue
- Warning before QR print: "148 bins have no position. Bidders won't see them on the pickup map."
- "Reset all pin positions" button
- Fix BUG-010 coord system mismatch first

**`/[id]/pickup-hours/PickupHoursForm.tsx`**:
- Support multiple windows per day (Add window button per day row)
- The JSONB schema already supports `DayWindow[]` — just stop truncating

**New: `/[id]/pickup-mode/page.tsx`**:
- Simple radio choice: Staff-assisted vs Customer pickup vs Hybrid
- Inline explanation of each
- Saves to `warehouses.pickup_mode` (added in Phase 1)

---

## Phase 3 — Bidder-app pickup screen split (LAUNCH-CRITICAL for Bingo)

### `apps/bidder-app/app/(tabs)/pickup.tsx` (list row)
Per-row badge: staging readiness ("All ready" / "1 of 3 ready" / "Preparing"), warehouse-timezone appointment time, mode label.

### `apps/bidder-app/app/pickup/[id].tsx` — branches on `pickup_mode`

#### Staff-assisted mode hero
```
┌──────────────────────────────────────────┐
│ MAIN STREET LIQUIDATORS                  │
│ West Little Rock Warehouse               │
│ 123 Commerce Dr, Little Rock AR          │
│ [Open in Maps ↗]                         │
├──────────────────────────────────────────┤
│ Your appointment                         │
│ Thu Jun 5 · 10:30-11:00 AM (CDT)         │
│ [Change time]                            │
├──────────────────────────────────────────┤
│ Status                                   │
│ ◉ 2 of 2 items staged and ready          │
├──────────────────────────────────────────┤
│         [QR CODE — 60% width]            │
│   Show this to the staff at counter      │
│   [Enlarge QR]                           │
├──────────────────────────────────────────┤
│ Your items (2)                           │
│ ✓ Sony WH-1000XM5      [staging photo]   │
│ ✓ Dyson V15 Vacuum     [staging photo]   │
└──────────────────────────────────────────┘
```

No map. No BinScanner. QR is the hero.

#### Customer-pickup mode hero
```
┌──────────────────────────────────────────┐
│ MAP — full-bleed, ~55% screen height     │
│   [SVG floor plan]                       │
│        (A)──────(B)                      │
│         ↑ entrance                       │
│                                          │
├──────────────────────────────────────────┤
│ Stop 1: Aisle A → Stop 2: B → Stop 3: C  │
├──────────────────────────────────────────┤
│ [Look for these spots]                   │
│ [photo A-02] [photo B-05] [photo C-01]   │
├──────────────────────────────────────────┤
│ Your items                            ↓  │
│ ☐ Sony Headphones · Bin A-02             │
│ ☐ Dyson Vacuum · Bin B-05                │
│ ☐ iPad Pro case · Bin C-01               │
├──────────────────────────────────────────┤
│ [All items? Confirm pickup]              │
│  (disabled until all checked)            │
└──────────────────────────────────────────┘
```

The "Confirm pickup" button calls the new `bidder_confirm_customer_pickup` RPC from Phase 1.

### Notification routing fix
`apps/bidder-app/app/_layout.tsx` — add `Notifications.addNotificationResponseReceivedListener`:
```ts
useEffect(() => {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    const inv = r.notification.request.content.data?.invoice_id;
    if (typeof inv === 'string') router.push(`/pickup/${inv}`);
  });
  return () => sub.remove();
}, []);
```

### Slot times in warehouse timezone (PickupScheduler)
`packages/domain-fulfillment/src/components/PickupScheduler.tsx` — accept `warehouseTimezone` prop, format slots via `Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: warehouseTimezone })`.

### Auto-create pickups row at payment
Webhook handler at `apps/operator-web/src/app/api/webhooks/stripe/route.ts` — on `payment_intent.succeeded`, after marking invoice paid, call `ensure_pickup_row(invoice_id)` (new RPC in Phase 1) so walk-in operators always have a QR token available.

### Post-pickup completion screen
After `bidder_confirm_customer_pickup` (customer mode) or `staff_confirm_pickup` (staff mode) succeeds, navigate to `/pickup/[id]/complete` showing "Pickup complete · Rate experience · Browse more auctions".

---

## Phase 4 — PickupMap UX polish

### `packages/domain-fulfillment/src/components/PickupMap.tsx`

**Replace nested ScrollView pan/zoom**:
- Today: outer vertical `ScrollView` + inner horizontal `ScrollView` with `maximumZoomScale={4}` (iOS-only)
- Future: `react-native-gesture-handler` PinchGestureHandler + PanGestureHandler + Reanimated. Works on iOS + Android.

**Interactive bin pins**:
- Each `<G>` for a bidder's bin wrapped with `<Pressable>` (via react-native-svg)
- onPress → opens `@gorhom/bottom-sheet` showing:
  - Bin code (A-02-3-04)
  - Aisle location
  - Full landmark photo
  - Staging photo of the lot at this bin
  - "Mark as collected" button (customer-pickup mode only)

**Landmark rail becomes interactive**:
- Tap landmark card → animates map zoom/pan to center the corresponding bin and highlight it

**Numbered route pill rail**:
```
Stop 1 of 3: Aisle A   →   Stop 2: Aisle B   →   Stop 3: Aisle C
```
Above the map. The route line in the SVG remains.

**Confirm bin coord alignment with floor_plan_width_px**:
This relates to BUG-010 above. After Phase 0 fix, verify SVG viewBox matches `floor_plan_width_px` x `floor_plan_height_px` exactly.

---

## Files affected by phase

| Phase | Files |
|---|---|
| 0 (bugs) | `apps/field-mobile/app/(staff)/layout/sketch.tsx`, `apps/field-mobile/app/(staff)/layout/floorplan-photo.tsx`, `apps/operator-web/src/app/(operator)/warehouses/[id]/floorplan/{FloorPlanEditor,actions}.ts*`, `apps/operator-web/src/app/(operator)/warehouses/[id]/pickup-hours/{page,actions}.ts*`, `packages/db/migrations/0094_pickup_mode_and_lifecycle.sql` (also contains bug fixes that are SQL-level: H7 restore, intake FOR UPDATE, bidder RLS scoping) |
| 1 (data) | `packages/db/migrations/0094_pickup_mode_and_lifecycle.sql`, `packages/shared/src/database.types.ts` |
| 2 (operator UI) | `apps/operator-web/src/app/(operator)/warehouses/[id]/page.tsx` (new setup hub), `apps/operator-web/src/app/(operator)/warehouses/[id]/bins/{page,BinForm,actions}.ts*`, `apps/operator-web/src/app/(operator)/warehouses/[id]/floorplan/{page,FloorPlanEditor,actions}.ts*`, `apps/operator-web/src/app/(operator)/warehouses/[id]/pickup-hours/{page,PickupHoursForm,actions}.ts*`, NEW `apps/operator-web/src/app/(operator)/warehouses/[id]/pickup-mode/{page,actions}.ts*` |
| 3 (bidder UX) | `apps/bidder-app/app/_layout.tsx` (notification routing), `apps/bidder-app/app/(tabs)/pickup.tsx`, `apps/bidder-app/app/pickup/[id].tsx` (mode branching), NEW `apps/bidder-app/app/pickup/[id]/complete.tsx`, `packages/domain-fulfillment/src/components/PickupScheduler.tsx` (timezone), `apps/operator-web/src/app/api/webhooks/stripe/route.ts` (ensure_pickup_row call) |
| 4 (map) | `packages/domain-fulfillment/src/components/PickupMap.tsx`, possibly `packages/domain-fulfillment/src/components/BinLandmarkRail.tsx` (make interactive) |

---

## How to resume this work in a fresh session

1. **Read this file first** (`docs/warehouse-redesign-plan.md`).
2. **Read the 3 audit reports** — they're in the conversation transcript of `~/.claude/projects/C--Users-jmacl-Projects/5028239f-af58-40fc-af68-17bc145061dd.jsonl` from 2026-05-20 around the warehouse-redesign-plan timestamps. Or re-run the 3 agents with the prompts saved at the top of this conversation history if needed (each took ~3 min and ~$0.20).
3. **Pick a phase to start**:
   - If Bingo is going live this week: start Phase 0 (bug fixes), then Phase 1 (migration 0094), then Phase 3 (bidder pickup screens) in parallel with Phase 2 (operator setup hub).
   - If Bingo is going live in 2+ weeks: linear Phase 0 → 1 → 2 → 3 → 4.
4. **Use the same `npm run preflight` + GHA workflow** that's now standard. The mobile pieces of Phase 3+4 will be caught by the GHA simulator smoke if they introduce launch crashes.
5. **Keep operator-web typechecks clean** as you edit — run `cd apps/operator-web && npx tsc --noEmit` after each batch of changes.
6. **Reference `.claude/post-launch-backlog.md`** for items deferred from the launch-week iOS work — some intersect (e.g., AASA file for universal links — relevant when adding deep links to pickup screens).

---

## Open questions for the user (resolve before starting implementation)

1. **Hybrid mode** — should an operator be able to do BOTH (staff staging some lots, customer self-pick for others)? The schema allows `pickup_mode='hybrid'` but neither the UI nor the bidder app branches account for it. Simpler: drop hybrid for v1.
2. **Per-auction override** — the schema allows `auctions.pickup_mode_override`. Do operators want this granularity, or is per-warehouse enough?
3. **Customer-pickup security** — should bidders need to scan a verification QR (e.g., one at the entrance) before the map unlocks? Current design unlocks the map immediately when their invoice is paid. Could be a vector for casing the warehouse if not paired with physical staffing.
4. **Proxy pickup** — can a bidder send someone else (spouse, employee) to pick up? Today's flow assumes the original bidder. Easy enhancement: token sharing.
5. **No-show handling** — what happens to items left uncollected for N days? Currently no automated logic. Worth adding as a separate cron job.
6. **Mappedin migration trigger** — per the memory note, switch from SVG MVP to Mappedin Pro "at scale." What's the threshold? 10 operators? 1000 bins? Mappedin pricing dependent. Worth documenting the trigger criterion now.

---

## Reference: agent outputs

Three agents produced detailed reports during the 2026-05-20 audit. Their full text is in the conversation transcript:

- **Agent 1 (ui-ux-tester, operator + staff perspective)** — file path index, bug enumeration (BUG-001..BUG-010), TOP 5 UX friction points, redesign vision for operator-web setup hub
- **Agent 2 (ui-ux-tester, bidder perspective)** — current state screen-by-screen, missing-for-customer-pickup list, missing-for-staged-pickup list, opinionated map UX recommendation, redesign wireframes for both modes
- **Agent 3 (architect-reviewer)** — what's wired correctly, data model gaps, integrity/security issues, proposed migrations, top 3 architectural changes

If extracting agent text becomes inconvenient, re-run with the prompts at the top of the 2026-05-20 audit conversation — each prompt is self-contained and reproduces consistent output.
