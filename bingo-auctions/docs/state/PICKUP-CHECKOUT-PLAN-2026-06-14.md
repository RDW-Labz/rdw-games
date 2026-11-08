# Pickup / Checkout — June-14 recap build plan (cold-start ready)

**Read this first next session.** Investigation is DONE + root causes verified against prod; this is execution-ready. Build carefully — **real money is LIVE on this exact pickup/checkout flow** (single-account cutover 2026-06-14, acct_1TWlcf). None of the items below block the current test round (tester said name "not a launch blocker," "valid QR possession has been sufficient," consolidation = improvement, ID toggle = future).

Repo state: edit off `origin/master` (local checkout is stale). **Next migration = 0206.** Current builds: bidder TestFlight **45**, staff **57**.

## Scope (from ClovrBid Testing Recap – June 14)
1. **(High) Browser pickup QR fails** — staff scanner returns "Token not found" / "No active pickup matched this QR".
2. **(High) Staff checkout shows "Bidder (no name on file)"** though the bidder has a name.
3. **(Med-High) Receipt consolidation** — scan bidder QR once → load ALL their active invoices/pickups/lots in one checkout session.
4. **(Future) Lot-level "ID Required" toggle** — per-lot flag → staff sees "ID Verification Required" at pickup. Deferred.

## VERIFIED root causes (don't re-investigate)

### #1 — there is NO web pickup QR at all
- App QR (works): `apps/bidder-app/app/pickup/[id].tsx:475-516` renders `QRCode value={`bidwizops://pickup/${checkInToken}`}` where `checkInToken = pickups.bidder_check_in_token` (fetched by invoice_id, :247-249). Gated `{checkInToken && !isCompleted}`.
- Staff scanner: `apps/field-mobile/app/(staff)/checkout/pickup-verify.tsx` — `extractToken()` (:124-139) pulls a uuid from `pickup[:/]+<uuid>` or a bare uuid; resolves via `.from('pickups').select(...).eq('bidder_check_in_token', token).single()` (:268-279); the **"Token not found" / "No active pickup matched this QR"** alert is :276 when that query returns nothing.
- Web: `apps/operator-web/src/app/profile/invoices/[id]/page.tsx` shows the receipt but **renders no QR**. The only `/qr` route (`apps/operator-web/src/app/qr/page.tsx`) is a **dev-only Expo-Go preview QR** (hardcoded LAN IP) — unrelated. So bidders on the website have no pickup QR; whatever the tester scanned didn't carry a `bidder_check_in_token`.
- **Fix = BUILD a web pickup QR** (missing feature), encoding the EXACT same `bidwizops://pickup/{bidder_check_in_token}` the scanner extracts.

### #2 — bidders RLS gap (verified in prod)
- `public.bidders` has exactly ONE select policy: `bidders_self_read` USING `(id = auth.uid())`. **No operator-staff read path.**
- So pickup-verify's join `invoices.select('bidders(display_name, email)')` (:286-398) returns `bidders = null` for the staff session → `bidder_name`/`bidder_email` null → blank (the literal "(no name on file)" isn't in the code; tester paraphrased). Displayed at :818-823 `{invoice.bidder_name ?? invoice.bidder_email}`.
- **Fix = column-safe scoped read.** Do NOT add a blanket `bidders` staff-read policy (leaks email/phone/`stripe_customer_id`/`default_payment_method_id` cross-row). Use a SECURITY DEFINER RPC (below) or a `bidders_public`-style view returning ONLY display_name + email, scoped to bidders who have an invoice with the caller's operator.

### #3 — one pickup/token/QR per invoice
- `pickups` (mig 0001): `invoice_id` FK (1 row per invoice), `bidder_check_in_token uuid UNIQUE`, status enum `pending|scheduled|completed|no_show|forfeited`.
- `staff_confirm_pickup(p_invoice_id uuid, p_lot_codes text[])` (mig `0079_staff_confirm_pickup...`:177-312) is SECURITY DEFINER: auth + cross-tenant check (invoice.operator_id = current_operator_id), flips `bin_assignments.status` staged→picked_up per lot, closes the pickup (status=completed, completed_at), enqueues `pickup_confirmed` push. **One invoice per call.**
- A bidder with N won invoices = N pickup rows = N tokens = N QRs → staff repeat checkout N times. That's the consolidation pain.

## Build plan (phased; each its own PR; CI-gate; money-path = review)

### Phase A — DB foundation (mig 0206, additive/safe, INERT until wired)
Create **`staff_scan_bidder_token(p_token uuid)`** SECURITY DEFINER, STABLE. Solves #2 + #3 data in one place:
1. Resolve `p_token` → the pickup → its `invoice.bidder_id`. If no match → return empty (caller shows "Token not found").
2. Authorize: caller must be operator staff (`current_operator_id()` not null) AND the scanned invoice's `operator_id = current_operator_id()` (cross-tenant guard, mirror 0079).
3. Return: bidder `display_name` + `email` (column-safe — only these two → fixes #2); and **all the bidder's ACTIVE pickups at THIS operator** — `invoices.bidder_id = <bidder>` AND `invoices.operator_id = current_operator_id()` AND `invoices.status='paid'` AND `pickups.status IN ('pending','scheduled')` — each with its invoice_id, token, lots (invoice_lots→lots: lot_code, title) + latest `bin_assignments` (bin_code, staged/picked_up), + combined lot count.
- Shape: return a single JSON object `{ bidder:{name,email}, pickups:[{invoice_id, status, lots:[{lot_code,title,bin_code,staged}]}], total_lots }` (jsonb) — easiest for the RN client.
- Test: `packages/db/test/staff_scan_bidder_token.regression.test.ts` — multi-invoice bidder returns all active pickups + name; cross-operator token denied; completed pickups excluded; smoke.
- Keep `staff_confirm_pickup` per-invoice; the UI calls it per invoice in the combined flow (or add `staff_confirm_pickup_bulk` later if the loop is too chatty).

### Phase B — Web pickup QR (operator-web; #1; CF deploy)
- On the bidder web pickup/invoice page (`profile/invoices/[id]` or a new `profile/pickup/[id]`), fetch `pickups.bidder_check_in_token` by invoice_id (server, getSupabaseServer — the bidder reads their own pickup; confirm `pickups` has a bidder self-read RLS path, else read via an RPC) and render a QR encoding `bidwizops://pickup/{token}` — **byte-identical to the app** so `extractToken()` matches. Gate: show when token present + pickup not completed. Use a QR lib already in the web deps (check `qrcode`) or `qrcode.react`.
- Verify after deploy: generate on web → scan with staff app → resolves (no "Token not found").

### Phase C — Staff app consolidation (field-mobile; #2 + #3; OTA)
- Rework `(staff)/checkout/pickup-verify.tsx`: after scan, call `staff_scan_bidder_token(token)` → show the **bidder name** (fixes #2) + a combined, sectioned list of ALL their active invoices/lots (bidder name, each invoice, all lots, combined count). Staff check off lots across invoices in one session; on confirm, call `staff_confirm_pickup` for each invoice (loop) — or the bulk RPC.
- Keep the existing single-invoice fallback if `staff_scan_bidder_token` returns one pickup.
- Ship via OTA (no native dep change). Reaches staff build 57.

### Phase D — Lot-level "ID Required" toggle (#4; FUTURE, deferred)
- mig: `lots.id_verification_required boolean default false`. Set at lot create/edit (operator-web lotting UI + field-mobile quick-lot). Staff checkout: if any lot in the pickup has it, show "ID Verification Required" banner + a staff-confirm checkbox before `staff_confirm_pickup`. Intended for high-value/jewelry/electronics/gift cards/cage.

## Landmines
- Real money is LIVE on this flow → `staff_confirm_pickup` + the consolidation confirm are money-adjacent; test the multi-invoice confirm path carefully (don't double-confirm or skip an invoice).
- Column-safe bidder read only (no stripe/PII). Never a blanket bidders staff-read policy.
- Web QR must encode EXACTLY `bidwizops://pickup/{token}` (scanner regex `pickup[:/]+([0-9a-f-]{36})`).
- Local `npm install` is broken on Windows-ARM → CI is the only local typecheck/test gate. Edit off `origin/master`.
- Order: A (inert RPC + test) → B (web QR + CF deploy) → C (staff OTA) → D future.
