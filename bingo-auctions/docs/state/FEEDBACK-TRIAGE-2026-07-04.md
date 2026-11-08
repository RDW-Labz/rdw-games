# Tester Feedback Triage — 2026-07-04 (round 7, launch readiness)

Tester recap: (1) policy settings reviewed — dispute window 0 confirmed, but
"updated No-show Forfeit Threshold from 3 to 0" and asked for clearer
descriptions; (2) two carryover lots show legacy BIN numbers on the browser
auction listing (pickup screen shows the sticker codes correctly);
(3) staff-app refund flow works but messages still say Stripe / Stripe
Connect; (4) feature request: partial checkout for multi-trip pickups.
Verdict: browser ready for public launch.

## 1. No-show threshold "set to 0" — ⚠️ that save was REJECTED; use 1

`operators.no_show_forfeit_threshold` has a DB CHECK of **1–20** (mig 0144)
and the policies form refuses 0 with an inline error — so the change from
3 → 0 **did not save; prod is almost certainly still at 3.** If the dispute
window was changed in the same submit, that didn't save either — worth
re-checking.

The semantics (mig 0166): a no-show forfeits when the bidder's no-show count
in a rolling 90-day window — **counting the current one** — reaches the
threshold. So the zero-tolerance policy the tester wants is:

> **Threshold = 1** (first no-show forfeits immediately, no history needed)
> **Forfeit cooldown = 0** (no post-forfeit grace; every qualifying no-show forfeits)

Cooldown clarified: it's a grace window *after* a forfeit during which the
same bidder's further no-shows stay ordinary no-shows (protects a bidder
from losing several invoices in one bad week). 0 disables the grace.

**Fixed in this PR:** both field hints now spell out exactly this, including
"0 is not allowed — 1 already means first-offense forfeits."
**Action for Michael:** in Settings → Policies set threshold **1** +
cooldown **0**, and confirm the dispute window really shows 0 after saving.

## 2. Legacy BIN numbers on browser listing — display bug, fixed

The homepage "ending soon" lot cards (`home-client.tsx`) printed raw
`lot_code` — the only public surface that does; the auction grid/browse
cards show no code and the lot detail page was already sticker-aware. Since
pickup shows the right codes, data was fine — pure display gap.

**Fixed:** homepage rail now selects `sticker_code` and renders
`stickerLabel(sticker_code) ?? lot_code` (same rule as everywhere else);
routing still uses the canonical `lot_code`. Ships with the next
bingo-web deploy — no OTA needed.

## 3. Staff refund messages say Stripe — already fixed; device needs the OTA

The exact strings the tester quoted were replaced in PR #24 (`5c03a66`,
merged 2026-07-03: "Refund submitted to Square… once Square processes it")
and OTA'd to field-mobile the same day (run 28677655853, preview +
production). The tester's staff device is on an older bundle:
**force-quit and relaunch twice.** If the strings persist after that, the
staff binary's runtime version has drifted → ship a fresh staff EAS build.
(Note: the bidder app got a "tap to check for updates" row in PR #35; the
staff app has no equivalent yet — worth porting if OTA-lag keeps burning
tester rounds.)

## 4. Partial checkout — already built; needs migration 0217 applied

Mig 0217 (`888b47b`, PR #28, merged 2026-07-03) implements exactly the
request: per-lot handover stamps (`invoice_lots.picked_up_at`), the pickups
row stays open at `checked_in` after a partial round, the bidder's QR keeps
resolving, the no-show sweep skips it, and round 2 only owes what round 1
didn't stamp. The staff-side confirm dialog already drives it (0147's
`p_allow_incomplete`).

**It was merged flagged "NOT yet applied" to prod.** Action for Michael:
verify/apply — `node scripts/apply-migrations.js --rerun
0217_partial_invoice_pickup.sql` via the pooler (single-file `--rerun` only;
BinGo prod `_schema_migrations` is not blanket-apply safe). 0219 was applied
on 7/3 for PR #35, so 0217 may or may not have gone with it — check first.
No client change needed once applied.

## Reply for the tester

1. **No-show policy**: good catch on the confusing copy — it's rewritten.
   One correction: 0 isn't a valid threshold (your change didn't save — the
   form shows an error). **1 is the zero-tolerance setting** (first no-show
   forfeits immediately); we'll set threshold 1 + cooldown 0.
2. **BIN numbers on the listing**: real bug on the homepage cards — fixed;
   live with the next site deploy.
3. **Stripe refund wording**: fixed two days ago, your staff app just hasn't
   picked up the update — force-quit and relaunch it twice.
4. **Partial checkout**: already built exactly as you described (customer
   takes what fits, the rest stays Ready to Collect, their QR keeps working
   for the return trip). It's waiting on a server-side switch we'll flip —
   no new app needed.
