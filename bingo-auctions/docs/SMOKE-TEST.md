# End-to-end smoke test

The 90-minute happy-path checklist. Run this against a fresh local stack
before signing off on any release. If any step fails, the platform isn't
shippable.

Prereqs assumed: Phase 0 setup complete (Supabase running, Stripe test keys
in env, all `.env` files filled in). Note: Redis is no longer required —
the auction engine now runs as Supabase pg_cron + a Cloudflare cron Worker
instead of BullMQ. See [`PHASE-0-NEXT-STEPS.md`](./PHASE-0-NEXT-STEPS.md)
for setup history (historical reference only).

## 0. Boot

```bash
# Two terminals (auction-engine no longer needs a local process):
npm run dev -w @auction-platform/operator-web      # → http://localhost:3000
npm run start -w @auction-platform/bidder-app      # Expo Dev Tools, scan with Expo Go
```

For the auction engine to actually fire (close lots, drain notifications, etc.),
either deploy the Cloudflare side (`bash scripts/deploy-cf.sh`) or rely on the
already-deployed `bidwizops-cron` Worker if you're testing against the hosted
Supabase project. Locally, pg_cron isn't running unless you've enabled it on
your local Supabase instance — most smoke tests use the hosted project.

Also leave `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
running so subscription / payment / refund / identity events reach the
webhook handler in dev.

## 1. Operator onboarding (web)

1. Open http://localhost:3000.
2. Click **Become an operator**. Fill in business name, slug `cluer-test-1`,
   email + password.
3. After signup you should land on **/onboarding**. Click **Connect Stripe**.
4. Complete the test-mode Stripe Express onboarding (use the magic test
   tax IDs and 000-00-0000 SSN). On return you should see "Almost there"
   then auto-redirect to **/auctions** once the webhook lands (a few seconds).

✅ Pass: `operators.status='active'`, sidebar nav visible.

## 2. Warehouse + bins + floor plan

1. **/warehouses** → **New warehouse**. Fill in any US address.
2. After redirect to **/warehouses/[id]/bins**:
   - Generate bins via the **Bulk add** tab: aisle `A`, bays `1-3`,
     levels `1-2`, positions `1-2` → 12 bins.
3. Click **Floor plan →**. Upload any PNG (a hand-drawn rectangle works).
   The operator-web should auto-read dimensions and store them.
4. Drag at least 4 bin pins around to non-default locations.
5. Click **Set entrance**, then click somewhere near the bottom of the
   floor plan. The orange Entrance pin should appear.
6. Back on **/warehouses/[id]/bins**, click **Print QR sheet** — a multi-
   page PDF should open with one QR per bin.

✅ Pass: floor plan + entrance + bin coordinates persisted; PDF readable.

## 3. Auction + lot creation

1. **/auctions** → **New auction**. Format: **Standard**. Bidding starts
   in 1 minute, ends in 5 minutes. Pickup window starts 1 minute after
   bidding ends.
2. On the auction detail page, **Add lot** → fill in title, condition
   `good`, starting bid `$1`, no photos. Repeat for 2 more lots.
3. Click **Schedule auction**. Status flips to `scheduled`. The
   auction-engine console should log scheduled close jobs.

✅ Pass: 3 lots scheduled, BullMQ has `close:<lotId>` jobs queued.

## 4. Bidder signup + bidding (mobile)

1. In Expo Go on a phone (or the iOS simulator), open the bidder app.
2. **Create account** → email + password.
3. The browse tab should show the 3 scheduled lots once the auction's
   `starts_at` passes.
4. Tap a lot → **Place bid** at the suggested minimum.
5. Open the same lot on a second device with a second bidder account.
   Place a higher bid.
6. The first device should:
   - See the current price tick up via Realtime.
   - Receive an `outbid` push notification within 5 seconds (if the
     device has a real Expo push token).
7. Place a bid above $500 on the first account → identity verification
   alert pops up. **Verify now** opens Stripe Identity in WebBrowser.
   Skip in test mode (or use a test ID).

✅ Pass: place_bid RPC accepted; outbid notification fired; identity gate
triggered at threshold.

## 5. Auction close

1. Wait for the lots' `close_at` to pass.
2. The closeLot worker fires `finalize_lot` → status flips to `won`,
   `won` notification pushes to winners, build-invoices job is queued
   (30s debounce).
3. Within ~30s, an invoice should appear in **/invoices** on the operator
   side and in **My bids → Won** on the bidder side.

✅ Pass: lots `won`, invoice generated with subtotal + buyer premium +
application fee, `won` notification received.

## 6. Payment

1. Bidder app: **My bids → Won → tap a lot** → opens the invoice screen.
2. Tap **Pay** → PaymentSheet opens. Use Stripe test card `4242 4242 4242 4242`,
   any future expiry, any CVC, any ZIP.
3. After confirm, invoice flips to `paid`, payment_intent.succeeded
   webhook fires.
4. Operator **/invoices** shows status `paid`, **/payouts** shows the
   pending balance increase.

✅ Pass: bidder is `paid`, operator's Stripe Connect balance reflects
the transfer minus app fee.

## 7. Pickup staging (picker mode)

1. On the bidder app, sign out and sign in as an `operator_users` admin
   (you'll need to create one in Supabase Studio — paste this SQL,
   replacing the email):
   ```sql
   INSERT INTO operator_users (operator_id, user_id, role, email, accepted_at)
   SELECT '<operator-id>', id, 'picker', email, now()
   FROM auth.users WHERE email = 'picker@example.com';
   ```
2. Profile tab → **Open picker mode** → **Stage a lot**.
3. Print the lot UUIDs as QR codes (use any QR generator — paste the
   `id` from the lots table). Print bin QRs from the QR sheet PDF.
4. Scan a lot QR → tap **Continue** → take a staging photo → scan a
   bin QR. Should succeed.
5. Repeat for all winning lots in the invoice. After the last one is
   staged, the bidder should receive a `pickup_ready` push.

✅ Pass: bin_assignments rows have status='staged', staging_photo_url
populated, pickup_ready notification fired.

## 8. Bidder pickup

1. Bidder side: **Pickup tab** lists the paid invoice. Tap it.
2. The map shows the floor plan, bidder's bins highlighted, the route
   line walks from the entrance through them in walking order.
3. Each lot tile shows the staging photo thumbnail.
4. Tap **Schedule pickup** → pick any slot.
5. Tap **Scan bin QR**, scan one of the bin QRs from the printed sheet.
   Should mark all of the bidder's lots in that bin as `picked_up`,
   bin turns green on the map.
6. Repeat for all bins.

✅ Pass: all lots `picked_up`, route line empty, bins all green.

## 9. Dispute + refund

1. Bidder side: **Pickup detail → Report a problem** on any picked-up lot.
2. Take 2+ photos, type 20+ characters of reason, submit.
3. Operator side: **/disputes** shows the open dispute. Tap **Review**.
4. Compare bidder photos vs original listing photos. Click **Resolve**,
   issue a $5 partial refund, save.
5. Bidder app receives a `dispute_update` push. Stripe issues the partial
   refund; webhook flips invoice to `partially_refunded`.

✅ Pass: dispute resolved, refund processed at Stripe, invoice status
correct, bidder notified.

## 10. Operator pickups dashboard

1. Operator side: **/pickups** lists the completed pickup under "Past".
2. Schedule another bidder for tomorrow, mark them no-show. Their lots
   flip to `relisted` in **/lots**.
3. Open one of those relisted lots → **Relist** dropdown picks an
   upcoming auction → click. The lot copies into that auction.

✅ Pass: no-show flow works, relist creates a new lot, original tracks
the original status.

## 11. Subscriptions

1. Bidder side (Android, or web via direct URL): **Profile → Subscription
   → Subscribe to Pro**. Stripe Checkout opens with the test price.
2. Pay with `4242 4242 4242 4242`. Return to app.
3. Bidders.subscription_status flips to `active` via webhook.
4. Lots with `early_access_until > now()` should be visible to the bidder
   (verify via SQL or by setting one in the operator-side lot form).

✅ Pass: subscription active, early-access RLS gate honors it.

## 12. Notification preferences (push / email / SMS)

1. Bidder app → **Profile → Edit profile**.
2. Confirm: **Push** + **Email** toggles default ON, **SMS** defaults OFF
   and is greyed out until a phone number is entered.
3. Enter a phone number (any format — `(555) 555-5555`, `5555555555`,
   `+15555555555`). Save → re-open the screen → phone is shown in
   E.164 (`+15555555555`).
4. Toggle Push OFF, leave Email ON. Save.
5. Trigger an outbid event (place a higher bid from a second account).
   Check `notifications_outbox` row for that bidder:
   - `processed_at` set with `last_error='push_disabled'`.
   - `emailed_at` populates within ~5s (no error).
6. Toggle Email OFF, Push back ON. Trigger another outbid:
   - `processed_at` populates (push delivered).
   - `emailed_at` set with `last_email_error='email_disabled'`.

**SMS (only if Twilio env is set on auction-engine):**
1. Toggle SMS ON, save. Trigger an outbid → `smsed_at` populates within
   ~5s. Phone receives a short text with a link.
2. Without Twilio env: confirm engine logs `sms worker disabled` at
   startup; outbox rows leave `smsed_at` null indefinitely (no error).

✅ Pass: each channel respects its toggle independently; SMS toggle
locked behind a saved phone; missing Twilio doesn't break the engine.

## 13. Health endpoint

1. With auction-engine running locally: `curl http://localhost:3100/health`
   → `{"ok":true,"supabase":true}` and HTTP 200.
2. Stop Supabase or break `SUPABASE_URL` → endpoint returns 503 with
   `{"ok":false,"supabase":false}`. Restore env.
3. `curl http://localhost:3100/` → `200 ok` (root probe path for LBs).

✅ Pass: 200 when healthy, 503 when DB unreachable, root returns 200.

## 14. Inventory flow (Phase 17+)

The new model: imports → inventory → auction. Sections 3-4 above use the
direct manual lot-creation path; this section exercises the inventory
flow you'll run with real manifests.

### 14a. Smart Import

1. **/imports** → **+ New import**.
2. Upload any CSV or XLSX (the seeded `lowes_run_*.xlsx` is a good test).
   Step 1 parses client-side via PapaParse / SheetJS.
3. Step 2 — column mapping. Auto-detected fields are pre-filled as orange
   pills. Tap **+ map to…** to add a second target field to the same
   source column (e.g. one description column populating both Title AND
   Description). Verify Title is mapped to at least one column.
4. If the manifest has pre-stickered identifiers (UPC sticker, route
   stop, asset tag), map that column to **External code (pre-stickered
   ID)** so intake can scan it later.
5. Step 3 — preview. Pick optional warehouse, optional source label.
   Click **Import N → inventory**.
6. After commit, **Imports** list shows the row with classification %
   (e.g. "44%" if alias-keyword matching found a category for ~half).

✅ Pass: all rows land as `pending_intake` with `auction_id IS NULL`,
each gets a unique `lot_code` (`RDW-000NNN`), `external_code` set
where mapped, audit row in `imports`.

### 14b. Intake scanner

1. Bidder app → **Profile → Open picker mode → 📥 Intake**.
2. Scan or type a lot identifier — `RDW-000201`, the lot's UUID, or
   the operator's external_code (UPC, SKU, etc).
3. Confirm the resolved lot (title + category + status pill).
4. Scan a bin QR.
5. Lot status flips to `in_inventory`, `intake_bin_id` set,
   `warehouse_id` derived from the bin (authoritative — the import-time
   warehouse is just a hint).

✅ Pass: lot moves to `in_inventory` in `/inventory`. Try scanning a lot
that already in_inventory → succeeds (idempotent re-bin). Try scanning a
lot from a different operator → `lot_other_operator`.

### 14c. Auction Builder

1. Operator-web → **/auctions** → create or open a draft auction.
2. Click **+ Add from inventory** → `/auctions/[id]/build`.
3. 2-col photo grid of inventory at the auction's warehouse. Filter by
   category, search by title or lot code.
4. Multi-select N items. Action bar shows the lot-number range
   ("Add 47 as #1–#47").
5. Click commit. Server action assigns `auction_id` + sequential
   `lot_number` + flips status to `scheduled`. Lots disappear from
   `/inventory`, appear in the auction's lot list.

✅ Pass: lots in the auction with sequential numbers, no number
collisions if you repeat the action, RLS denies the action when run by a
non-admin operator user.

### 14d. Bulk delete inventory

1. **/inventory** → check rows you want to remove (use the header
   checkbox to Select All, or per-row checkboxes).
2. Sticky orange action bar shows count + Delete button.
3. Confirm dialog → action deletes only `pending_intake` /
   `in_inventory` rows for the calling operator. Live + won lots are
   protected at the action layer.

✅ Pass: deleted count returned in result; live lots in another auction
on the same operator unaffected.

## 15. My Bids tabs

1. Bidder app → **My Bids** tab (after placing at least one bid).
2. Top of screen: horizontal pill row — **All / Won / Leading /
   Outbid / Lost** with count badges on each.
3. **Won** pill auto-highlights with a thicker green border when count
   > 0. Tapping filters the list.
4. Each row shows the lot_code in monospace orange above the title,
   tone-coded accent stripe (yellow/red/green/grey).
5. Won rows render the rubber-band WON stamp; tap goes to invoice.
6. Effective-close handling: if a lot's `close_at` has passed but the
   closeLot worker hasn't fired (status still `live`), the row still
   classifies as Won/Lost based on `winner_bidder_id`.

✅ Pass: all bids visible, won items findable in one tap, error
banner (red) appears if the bids query fails.

## 16. Saved searches

1. Bidder app → **Browse** → enter a search query OR pick a category OR
   set a discount filter.
2. **💾 Save this search** pill appears below filters. Tap → saves with
   auto-generated name.
3. **Profile → Saved searches** → row appears with notify toggle.
4. Apply button re-applies the criteria to Browse.
5. Auction-engine matcher worker (5-min interval) finds new lots
   matching saved criteria, enqueues `saved_search_hit` notifications.
6. Verify push/email/SMS templates surface "🔔 New match: {searchName}"
   with the lot_code in the body.

✅ Pass: saved row stable across app restarts, push fires per match
(idempotency_key prevents duplicates), mute toggle stops further
notifications without deleting the search.

## 17. Failure modes worth poking

- Stop Redis, try to schedule an auction → operator sees a friendly
  error, DB state remains consistent (auction stays scheduled, no jobs).
- Force a Stripe webhook signature mismatch → 400 from
  `/api/webhooks/stripe`, no DB writes.
- Disconnect from internet during a bid → the place_bid RPC returns
  network error, no row inserted (verify in Supabase Studio).
- Try to bid as an unauthenticated user via Postman against the RPC
  endpoint → returns `not_authenticated`.

If everything passes, the platform is ready for an operator to actually
use. If anything fails, log it as a regression and don't ship until
green.
