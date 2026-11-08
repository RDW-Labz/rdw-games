# Tester Feedback Triage — 2026-07-02 (BinGo build 9 / staff build 4)

Tester recap: **blocked on adding any payment method.** Browser: every card
→ "Value is too long." (yesterday: "Card declined. Try another card.").
App: card form won't take keyboard input — "appears to expect the card to be
scanned", CVV/ZIP can't be entered at all.

## Root causes (verified, not theorized)

### 1. Square idempotency keys exceeded Square's 45-char hard cap — ALL card saves broken since the 6/30 cutover
`POST /v2/cards` was sent `idempotency_key = card:{uuid}:{token24}` = **66
chars**. Square caps the field at **45** and rejects the whole request with
`VALUE_TOO_LONG` — the card never reached actual card validation. Confirmed
by probing the live Square API with the exact prod key shapes (invalid
source ids, nothing created):

| Call | Key shape (old) | Len | Square verdict |
|---|---|---|---|
| CreateCard | `card:{uuid}:{token24}` | 66 | `VALUE_TOO_LONG field=idempotency_key` |
| CreatePayment (auto-charge) | `sq:invoice:{uuid}` | 47 | `VALUE_TOO_LONG` |
| CreateCustomer | `bidder-customer:{uuid}` | 52 | accepted (customers allow longer) |
| RefundPayment | `refund:{uuid}:{cents}` | 48+ | accepted (refunds allow longer) |

**Yesterday's "Card declined" was the SAME error** — pre-#12 the client
collapsed every Square error to a generic decline; #12 surfacing real codes
is what exposed it. DB blast radius at fix time: 9 bidders, **0 cards ever
vaulted**, 3 Square customers, `auto_charge_jobs` empty — meaning the
auto-charge key bug was caught **before any real auction close tried to
charge anyone**.

### 2. App card form: iOS keyboard dead in the auth-session sheet
The app has no native card form — it opens the web Square form via
`WebBrowser.openAuthSessionAsync` (ASWebAuthenticationSession sheet). On iOS
the Square card iframes never receive the keyboard there; the only visible
affordance is card-scan, and CVV/ZIP can't be typed (matches the tester's
report exactly). Every other web handoff in the app (identity, subscription,
legal) already used `openBrowserAsync`.

## Fixes shipped

**PR #19 (`886983b`) — merged, CF-deployed, OTA'd (bidder, preview+production) 2026-07-02:**
- CreateCard key = `sha256(card:{userId}:{token})` hex→45 (deterministic per
  token, collision-safe); customer `cust:{uuid}` (41); auto-charge
  `sq:inv:{uuid}` (43); refund `ref:{uuid-nodash}:{cents}` (≤44).
- `squareFetch` now **throws on any idempotency_key > 45** — the class can't
  ship silently again.
- `payment-method.tsx`: `openAuthSessionAsync` → `openBrowserAsync(url,
  FULL_SCREEN)` (SFSafariViewController). Reaches devices via OTA (relaunch
  the app twice).

**Post-deploy verification (prod, real path):** authenticated save-card with
a well-formed-but-invalid token now returns `402 card_declined
code=INVALID_CARD_DATA` — Square is evaluating cards again (old deploy
returned `VALUE_TOO_LONG`). Smoke bidder `e2e-cardsmoke@clovrbid.test`
exists for future prod smokes; its Square customer was deleted after the
test.

**PR #20 — CI gate un-broken (was red on master all day; every PR merged past it):**
- `schema migrations`: mig 0209 needs pgvector → service image
  `pgvector/pgvector:pg16`.
- e2e fork drift: `E2E_TEST_USER_PASSWORD` secret was never set (now set);
  `E2E_BASE_URL` defaulted to **clovrbid.com** (upstream site!) → now
  bingoauctions.com; `card-flow.spec.ts` rewritten Stripe→Square
  (`sq0idp-` app id + squarecdn iframe in `#sq-card-container`); LOW-5
  og:image assertion made host-agnostic (fork serves `/og-default.png`).
- With drift fixed, the suite went 24/25 and the one failure was a REAL
  bug it was right about: mobile header overflow (doc scrollWidth 488 on
  a 390px viewport). The rebrand put `display:'inline-flex'` inline on
  the wordmark span, defeating upstream's `.public-nav-wordmark
  { display:none }` mobile rule — phones rendered the full
  "BinGo ↗ AUCTIONS" lockup. Fixed by hiding just the ↗ AUCTIONS tail
  <480px via a class on the tail spans (inline-style-proof); "BinGo"
  stays as the home link. Verified live post-deploy: docW = exactly 390.
- The rewritten card-flow e2e (real browser, real login, prod) passing is
  an independent second confirmation of the PR #19 payment fix.

## For the tester
1. **Browser**: retry adding the card now — it will either save or give a
   specific reason (CVV / ZIP / decline), never "Value is too long".
2. **App (build 9)**: force-quit and relaunch **twice** (OTA applies on
   second launch), then Add card — the form opens full-screen in-app Safari
   and the keyboard should work in every field.
3. If the card saves, bidding/checkout testing is unblocked end-to-end; the
   win → auto-charge path is also expected to work now (it was broken the
   same way and fixed in the same PR).
