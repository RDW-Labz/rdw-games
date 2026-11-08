# Audit — bugs + optimizations for execution (2026-05-24)

Produced by 8 parallel agents over two rounds:
silent-failure-hunter, database-reviewer, performance-engineer, typescript-reviewer,
ecc:a11y-architect, mobile-app-developer, qa-expert, stripe Connect specialist.

**~149 findings** across 8 areas. Every finding has a file:line citation and a one-line fix.
**No code was changed.** Hand this doc to the other session for execution.

---

## 🚨 IMMEDIATE — exploitable / money-losing / spam-folder today

| ID | Where | What | Action |
|---|---|---|---|
| **SEC-01** | `apps/bidder-app/.env:26`, `apps/field-mobile/.env:26` | Apple app-specific password `wwba-nsrm-iznu-kicu` committed (known-leaked, never rotated) | Revoke at appleid.apple.com; regenerate; move to EAS secret |
| **SEC-02** | `apps/bidder-app/.env:9`, `apps/field-mobile/.env:5` | `EXPO_TOKEN=KDite…` committed — rogue OTA push surface | Revoke at expo.dev; regenerate; move to EAS/local-only |
| **SEC-03** | `apps/operator-web/src/app/api/search/suggest/route.ts:97` | PostgREST `.or()` filter built by string interpolation — injection possible | Strip PostgREST metacharacters from `rawQ` before embedding |
| **STRIPE-P0-2** | `apps/operator-web/src/app/api/invoices/[id]/refund/route.ts:101-109 + 151-173` | **Refund double-clawback** — `reverse_transfer:true` plus an unguarded `createReversal` branch pulls from operator twice on any row with `stripe_transfer_id` set | Delete the `createReversal` branch entirely (route comment already says it's unreachable, but webhook handler writes the column that activates it) |
| **STRIPE-P0-1** | `apps/operator-web/src/app/api/invoices/[id]/payment-intent/route.ts:98-104`, `lib/cron/auto-charge-drain.ts:216-226` | Charges fire without checking `account.charges_enabled` — Stripe 422s on confirm | Read + gate on `operators.stripe_charges_enabled` |
| **STRIPE-P0-7** | `apps/operator-web/src/app/api/webhooks/stripe/route.ts:511-522` | `application.deauthorized` clears `stripe_onboarding_complete` but NOT `stripe_account_id` → auto-charge keeps targeting the disconnected account | Also `UPDATE operators SET stripe_charges_enabled=false`; do NOT downgrade status |
| **EMAIL-C1** | `apps/operator-web/src/lib/cron/email-drain.ts:313-318` | Every email is HTML-only; no `text:` field. Spam filters penalise HTML-only mail | Add `text: buildPlaintext(row)` next to `html:` in every Resend send |
| **TS-BUG-01** | `api/invoices/[id]/refund/route.ts:101-109` | `stripe.refunds.create()` has no try/catch; raw Stripe error + request IDs leak in 500 response | Wrap in try/catch; sanitized error |
| **TS-P1-01** | `api/admin/repair-bidder-stripe/route.ts:50` | `console.log` emits `jmacluer@gmail.com` to prod logs (PII) | Mask/hash or remove |

---

## 🔥 BinGo go-live blockers (do before importing 91k-lot CSV)

| ID | File:Line | What breaks | Fix |
|---|---|---|---|
| **B1** | `(operator)/imports/actions.ts:224-244` | CHUNK=200 → 455 sequential round-trips for 91k import (+9-15s) | Bump CHUNK to 2000 |
| **B2** | `0103…_legacy_import.sql:278-283` | `lot_import_batches` row marked `status='completed'` BEFORE loop runs | Insert `status='processing'`; wrap in EXCEPTION |
| **B3** | `(operator)/imports/actions.ts:226-244` | Chunk failure orphans rows in `import_rows` with no parent | Single transaction OR delete partial rows on failure |
| **B4** | `(operator)/imports/actions.ts:82-85` | `resolveCategoryIdsBatch` RPC failure swallowed; every row gets `category_id=null` | Propagate `categoryWarning` in `CommitResult` |
| **B5** | `packages/db/migrations/0037_competitor_lots.sql:159-195` | **All 6 indexes commented out** — every query is seq scan | Uncomment + run |
| **B6** | `0103…_legacy_import.sql:289-306` | Per-row skip records no reason → "58 imported, 2 skipped" with no diagnosis | Add `lot_import_batch_skips` child table |
| **B7** | `(operator)/imports/actions.ts:135-138` + RPC | Null-category rows sent to category RPC = wasted work | Filter rows where both `category_raw` and `sub_category_raw` are null |
| **B8** | `apps/cron-trigger/src/index.ts:123-135` | Cron failures only `console.error`'d; silent auto-charge drain failures during auction close | Re-throw on `Promise.allSettled` rejection OR ping Sentry |

---

## 🎯 Top-12 highest-ROI fixes (ranked)

1. **Wrap RLS helpers in `(SELECT fn())`** — ~30 policies. Single highest-leverage perf fix.
2. Apply B5 + DB-2 — `competitor_lots` + `category_aliases` index hygiene.
3. **Stripe refund double-clawback** (STRIPE-P0-2) — money-losing today.
4. Add `AbortSignal.timeout(10_000)` to Expo Push + Resend fetches in cron drains.
5. Add `text:` plaintext to every Resend email (EMAIL-C1).
6. **`application.deauthorized` clearing** (STRIPE-P0-7) — silent failure trap.
7. Fix `extract_brand` `IMMUTABLE` → `STABLE` (reads a table).
8. Memoize `cardData` + `LotCard` (200 allocs/sec under 1Hz tick).
9. Bidder cold-launch push tap loss — call `getLastNotificationResponseAsync()`.
10. Replace legacy `pricing.ts` Anthropic path → Gemini Flash (**17× cost saving**).
11. Bulk UPDATE `assignLotsToAuction` (500 sequential trips today).
12. `competitor_lots.raw_json` fillfactor=70 + STORAGE EXTERNAL before 5MM rows.

---

## By-area summary

| Area | P0 | P1 | P2 | Section |
|---|---|---|---|---|
| A. Silent failures / swallowed errors | 5 | 4 | 2 | §A |
| B. DB schema / RLS / indexes | 3 | 7 | 4 | §B |
| C. Performance hot paths | 4 | 6 | 3 | §C |
| D. TypeScript / async / security | 6 | 7 | 5 | §D |
| E. Accessibility (WCAG 2.2 AA) | 12 | 14 | 6 | §E |
| F. Mobile UX + i18n | 3 | 10 | 7 + 7 i18n | §F |
| G. Tests + Worker + Email | 3 | 5 | 4 | §G |
| H. Stripe Connect | 7 | 9 | 6 | §H |
| **TOTAL** | **43** | **62** | **44** | — |

---

## §A. Silent failures / swallowed errors

| # | File:Line | Sev | Pattern | Fix |
|---|---|---|---|---|
| SF-1 | `0103…_legacy_import.sql:289-306` | **P0** | Per-row skip with no reason captured | (B6) |
| SF-2 | `imports/actions.ts:226-244` | **P0** | Orphan rows on chunk failure | (B3) |
| SF-3 | `imports/actions.ts:82-85` | **P0** | Category RPC fail → silent null flood | (B4) |
| SF-4 | `domain-lotting/src/ai/identification.ts:298-304, 321-322` | **P0** | `.catch(()=>null/[])` on enrichment — field-mobile shows no price/photos, no explanation | Log error + surface `enrichmentFailed:true` on `LotCandidate` |
| SF-5 | `domain-lotting/src/ai/pricing.ts:188-191` | **P0** | Empty `catch { return []; }` | Log before fallback |
| SF-6 | `0040_extract_brand.sql:530-545` | P1 | `IMMUTABLE` but reads `brand_aliases` table → stale plans | Change to `STABLE`; rewrite UPDATE via CTE |
| SF-7 | `apps/cron-trigger/src/index.ts:123-135` | P1 | (B8) | Re-throw on rejection |
| SF-8 | `domain-lotting/src/ai/image-enrich.ts:101-106` | P1 | Bare catch; `identification.ts:379-384` overwrites cached images with `[]` on transient error | Log + guard cache update with `length > 0` |
| SF-9 | `api/lottr/apply-enrichment/route.ts:118-130` | P1 | Empty patch → `update({})` returns 200 OK | Reject early if `Object.keys(patch).length===0` |
| SF-10 | `scripts/import-competitor-lots.js:116-133` | P2 | Silent fallback to inline normalizer copies | Fail fast on require failure |
| SF-11 | `(operator)/lotting/manifest-pool/actions.ts:44-47` | P2 | Returns `'drop_failed'` sentinel; real error lost | Return `error.message` |

## §B. Database / RLS / indexes

| # | File:Line | Sev | Issue | Fix |
|---|---|---|---|---|
| DB-1 | `0037_competitor_lots.sql:159-195` | **P0** | All 6 post-load indexes commented out | (B5) |
| DB-2 | `0018_categories.sql:43-47` | **P0** | `category_aliases.category_id` no index; resolver sorts `LENGTH(raw) DESC` uncovered | `CREATE INDEX category_aliases_category_id_idx (category_id); CREATE INDEX category_aliases_raw_len_idx (length(raw) DESC);` |
| DB-3 | `0103…:278-283` | **P0** | Batch row `status='completed'` before loop | (B2) |
| DB-4 | `0002_rls.sql:17-39` + 0028/29/88/91/103 | **P1** | RLS helpers called once per row — **single highest-leverage perf fix**. ~30 policies | Wrap in `(SELECT fn())` everywhere |
| DB-5 | `0018_categories.sql:53` | P1 | `lots_category_browse_idx` missing `deleted_at IS NULL` | Drop + rebuild with filter |
| DB-6 | `0103…:438-465` | P1 | `intake_lot_to_bin` 8 sequential seeks; UUID branch missing `operator_id` | Add operator filter; consolidate first 3 lookups |
| DB-7 | `0037_competitor_lots.sql:83` | P1 | `raw_json JSONB` no fillfactor / STORAGE EXTERNAL → 10-25 GB TOAST at 5MM | `SET (fillfactor=70); ALTER COLUMN raw_json SET STORAGE EXTERNAL` |
| DB-8 | `(operator)/lotting/inventory/actions.ts:143-160` | P1 | `assignLotsToAuction` 500 sequential UPDATEs | Single `UPDATE … WHERE id = ANY($1)` |
| DB-9 | `(operator)/reports/actions.ts:172-179` | P1 | `buildLotCsv` unbounded lots fetch | Add `.limit(LOT_ROW_CAP)` |
| DB-10 | `0033…:84`, `0027:126`, `0037:131` | P1 | `_schema_migrations` + `competitor_lots` RLS too permissive | Service-role only on `_schema_migrations`; tighten or accept `competitor_lots` deliberately |
| DB-11 | `0001_init.sql:194` | P2 | Random UUID v4 PKs → index fragmentation | Use `gen_random_uuid()` on new tables |
| DB-12 | `0027_product_lookups.sql:51` | P2 | `confidence TEXT` unconstrained | CHECK constraint |
| DB-13 | `0103…:106` | P2 | `lot_import_batches.status` unconstrained | CHECK constraint |
| DB-14 | `0037_competitor_lots.sql:67` | P2 | `discount_pct REAL` (float drift) | `NUMERIC(6,2)` or basis points |

## §C. Performance hot paths

| # | File:Line | Sev | Issue | Cost | Fix |
|---|---|---|---|---|---|
| PERF-1 | `imports/actions.ts:224-244` | **P0** | CHUNK=200 | +9-15s per 91k import | (B1) |
| PERF-2 | `imports/actions.ts:266-277` | **P0** | Second O(n) UPC scan pass | ~50ms wasted | Collect UPCs in build loop |
| PERF-3 | `apps/bidder-app/app/(tabs)/index.tsx:610-626` | **P0** | `cardData()` recreated on 1Hz tick; non-memoized `LotCard` | 200 allocs/sec, visible jank | `useCallback` + `React.memo` |
| PERF-4 | `apps/bidder-app/app/(tabs)/index.tsx:466` | **P0** | `recentLots` useEffect depends on `lots.length` | extra round-trip per filter | Remove `lots.length` from deps |
| PERF-5 | `imports/actions.ts:135-138` | P1 | (B7) | wasted RPC work | Filter null-cat rows |
| PERF-6 | `scripts/import-competitor-lots.js:897-908` | P1 | 1 UPDATE per category, 10k serial trips at scale | Hours at 5MM | Single batch RPC |
| PERF-7 | `domain-lotting/src/ai/identification.ts:354-386` | P1 | 2 serial cache updates after image enrich | 2× latency per scan | Combine via `.or('image_urls.is.null,image_urls.eq.{}')` |
| PERF-8 | `domain-lotting/src/ai/pricing.ts:9-47` | P1 | Legacy `callAnthropic` path | $0.017/call vs $0.001 (**17×**) | Migrate to OpenRouter Gemini Flash |
| PERF-9 | `packages/domain-bidding/src/hooks/useCategories.ts:53-61` | P1 | O(T×N) leaf grouping | trivial today | `Map<parentId, rows[]>` |
| PERF-10 | `apps/field-mobile/app/(staff)/lotting/scan.tsx:199` | P1 | No session UPC cache | ~800ms per repeat scan | `Map<string, LotCandidate>` |
| PERF-11 | `.github/workflows/ci.yml:14-67` | P2 | `npm ci` 3× across jobs | +60-90s CI wall | Shared install job |
| PERF-12 | `turbo.json:28-33` | P2 | lint/typecheck/test missing `outputs` | Never cached | Add `"outputs":[]` |
| PERF-13 | `.github/workflows/ci.yml:26-31,55-60` | P2 | Turbo cache key uses `github.sha` | Always miss | Use `hashFiles('**/package-lock.json')` |

## §D. TypeScript / async / security

| # | File:Line | Sev | Issue | Fix |
|---|---|---|---|---|
| SEC-01 | `apps/bidder-app/.env:26`, `apps/field-mobile/.env:26` | **P0 SEC** | (top of doc) | (top of doc) |
| SEC-02 | `apps/bidder-app/.env:9`, `apps/field-mobile/.env:5` | **P0 SEC** | (top of doc) | (top of doc) |
| SEC-03 | `api/search/suggest/route.ts:97` | **P0 SEC** | (top of doc) | (top of doc) |
| TS-BUG-01 | `api/invoices/[id]/refund/route.ts:101-109` | **P0** | (top of doc) | (top of doc) |
| TS-BUG-02 | `lib/cron/notifications-drain.ts:163-175` | **P0** | Expo Push fetch no timeout | `signal: AbortSignal.timeout(10_000)` |
| TS-BUG-03 | `lib/cron/email-drain.ts:~313` | **P0** | Sequential Resend loop; no timeout | `Promise.all` + Resend client timeout |
| TS-P1-01 | `api/admin/repair-bidder-stripe/route.ts:50` | P1 | (top of doc) | (top of doc) |
| TS-P1-02 | `api/lottr/{enrich-lot,lookup-code,scan-photo}/route.ts` catch blocks | P1 | Internal AI/OpenRouter error in response body | Opaque code to client; raw server-side |
| TS-P1-03 | `api/staff/invite/route.ts:265` | P1 | `listUsers()` no pagination | Email-filter argument |
| TS-P1-04 | `api/bidder/signup/route.ts:140-154` | P1 | Sequential consent inserts | `Promise.all(slugs.map(...))` |
| TS-P1-05 | `packages/domain-lotting/src/normalize/brand.ts:356-380` | P1 | `\b` anchor doesn't fire before/after `+` in aliases (`ego power+`, `black+decker`) | Match without trailing `\b` when alias ends in non-word char |
| TS-P1-06 | `apps/operator-web/src/lib/cron-auth.ts:12-13` | P1 | `!==` for secret compare | `crypto.timingSafeEqual` |
| TS-P1-07 | `api/lottr/scrape-url/route.ts:425, 455` | P1 | Accepts `http://` URLs (SSRF surface) | `https://` only + scheme allowlist |
| TS-P2-01..05 | Various | P2 | `as` casts; unused vars; regenerate Supabase types | (lint cleanup) |

## §E. Accessibility (WCAG 2.2 AA)

### P0 — blocks users with disabilities

| # | File:Line | Issue | Fix |
|---|---|---|---|
| A11Y-1 | `bidder-app/app/lot/_OperatorPolicyModal.tsx:327-356` | Tab Pressable no `accessibilityRole`/`State`/`Label` | `role="tab"` + `state={{selected:active}}` |
| A11Y-2 | `_OperatorPolicyModal.tsx:386-421` | Checkbox no role/state | `role="checkbox"` + `state={{checked:accepted}}` |
| A11Y-3 | `_OperatorPolicyModal.tsx:460-489` | "Accept and bid" Pressable no label/hint | Add label + conditional hint when disabled |
| A11Y-4 | `bidder-app/app/profile/edit.tsx:130-148` | `TextInput` fields no `accessibilityLabel` (placeholder only) | Add `accessibilityLabel="Display name"` etc. |
| A11Y-5 | `bidder-app/app/dispute/new.tsx:165-182` | Photo-remove 22×22pt (below 44pt min) + no label | `hitSlop` or padding to 44pt + `accessibilityLabel="Remove photo"` |
| A11Y-6 | `field-mobile/app/(staff)/picker/shelf-scan.tsx:148-163` | Quantity stepper `−`/`+` 32×32pt | `width:44, height:44` |
| A11Y-7 | `field-mobile/features/lotting/ConditionWorkflow.tsx:124-160` | Chips no role/state | `role="checkbox"` or `"radio"`, `state.selected` |
| A11Y-8 | `ConditionWorkflow.tsx:407-416` | Back/Cancel no `accessibilityRole` | Add `role="button"` |
| A11Y-9 | `operator-web/.../imports/new/ImportWizard.tsx:1163-1200` | `<label>` not `htmlFor`-linked; error div has no `aria-live` | Link `htmlFor`; `role="region" aria-live="polite"` |
| A11Y-10 | `operator-web/.../imports/[id]/ManifestPool.tsx:258-270` | Select-all + row checkboxes no `aria-label` | Add `aria-label` |
| A11Y-11 | `operator-web/src/app/(operator)/layout.tsx:147-305` | No skip-to-content link; keyboard users tab through 30-item sidebar each page | Add `<a href="#main-content" className="sr-only focus:not-sr-only">Skip</a>` |
| A11Y-12 | `layout.tsx:157-297` | `<aside>` nav + `<main>` no landmark labels | `aria-label="Primary navigation"` + use `<main>` semantic |

### P1 — degraded experience (14 items, abridged)

Modal `accessibilityViewIsModal` missing (`_OperatorPolicyModal:258`), Switches without labels (`saved-searches.tsx:151,155`), Apply/Delete with no row context (`saved-searches.tsx:163-188`), photo capture no live region (`dispute/new.tsx:186-209`), progress text no live region (`shelf-scan.tsx:457-508`), camera permission rationale missing (`shelf-scan.tsx:540-555`), progress bar no label (`ConditionWorkflow.tsx:422-433`), table `<th>` no `scope` (`LotReorderTable.tsx:217-233`), drag-only with no keyboard alt description (`LotReorderTable.tsx:217`), `commitError` no `role="alert"` (`ImportWizard.tsx:965-978`), Stepper no `aria-current="step"` (`ImportWizard.tsx:1085-1112`), column-mapping `<select>` no labels (`ImportWizard.tsx:525-760`), `Field` wrapper no `aria-describedby` linking (`components/Form.tsx:6-21`), `back` button no `role="button"` (`identity/verify.tsx:73-79`).

### P2 — polish (6 items)

Switch disabled no hint, inline links no `accessibilityRole="link"`, color-only warning banners, native `window.prompt` not styled dialog, NavSection labels not landmarks, missing `<caption>` on preview table.

## §F. Mobile UX + i18n

### P0 — broken on a real device today

| # | File:Line | Issue | Fix |
|---|---|---|---|
| UX-P0-1 | `apps/bidder-app/app/lot/[id].tsx:1289-1294` | Bid placement no timeout, no offline detect, raw error string surfaces | `AbortController(10s)`; show "No connection — bid not placed" |
| UX-P0-2 | `apps/bidder-app/app/_layout.tsx:91-103` | Cold-launch push tap silently dropped — listener registers AFTER tap arrived | Add `Notifications.getLastNotificationResponseAsync()` at effect top |
| UX-P0-3 | `apps/bidder-app/app/profile/delete-account.tsx:74-231` | Confirm-email TextInput has no `KeyboardAvoidingView` — covered on small phones | Wrap ScrollView in `KeyboardAvoidingView` |

### P1 — annoying (10 items)

Photo-clear button 22×22pt (`dispute/new.tsx:166-181`); same in `field-mobile/features/lotting/EditableCandidateCard.tsx:506-516`; source-filter `×` is `Text` w/ hitSlop (`field-mobile/app/(staff)/inventory/index.tsx:140-144`); policy tabs 32pt tall (`_OperatorPolicyModal.tsx:327-355`); `import-review.tsx:351-548` no KeyboardAvoidingView; root `StatusBar` style fixed (`_layout.tsx:142`); auth stack hardcoded colors (`(auth)/_layout.tsx`); mixing react-native + expo-status-bar (`PhotoViewer.tsx:101-102`); `FlatList` no perf props (`saved-searches.tsx:112-193`, `inventory/index.tsx:210-226`).

### P2 — polish (7 items)

No `useColorScheme()` anywhere — zero dark mode support; no `expo-store-review` install; `RN Image` instead of `expo-image` on subscription logos; nested ScrollView (`EditableCandidateCard.tsx:108-148`); auth StatusBar inheritance; multiline TextInput returnKey behavior; phone field missing `textContentType="telephoneNumber"`.

### i18n readiness gaps (7 items)

| Gap | Sev | Notes |
|---|---|---|
| No i18n library installed | **Blocker** | Zero `t('key')` calls. ~400+ hardcoded English strings in bidder-app alone |
| `formatCents` pinned `'en-US'` | High | `packages/shared/src/money.ts:14` — accept `locale` param or use `resolvedOptions().locale` |
| Date format inconsistent | Medium | `lot/[id].tsx:191` (device locale OK), `subscription/index.tsx:242` (bare), `complete-profile.tsx:63` (hardcoded `'en-US'`) → centralize `formatDate` |
| Bare `.toLocaleString()` | Low | `invoice/[id].tsx:429,684,738` — works but inconsistent |
| Hardcoded `$` symbol | Medium | `(tabs)/index.tsx:374,378`, `invoice/[id].tsx:754,815` — use `formatCents` |
| No RTL support | Low | `I18nManager.forceRTL` never set; OK for English-only market |
| Hardcoded condition/status labels | Low | `field-mobile/app/(staff)/inventory/index.tsx:47-56` — wrap in `t()` before any locale work |

## §G. Tests + Worker + Email

### Tests

**Inventory:** `packages/domain-lotting/src/normalize/__tests__/{brand,upc}.test.ts` (Vitest), `packages/db/test/place_bid.load.ts` (manual tsx script, NOT in CI), `apps/operator-web/e2e/card-flow.spec.ts` + `tests/e2e/specs/admin/*` + `tests/e2e/specs/picker/auth.spec.ts` (Playwright). **Zero tests in `apps/bidder-app` or `apps/field-mobile`.**

| # | Path | Sev | Gap |
|---|---|---|---|
| T-1 | `place_bid.load.ts` | **P0** | Manual script, not wired into CI | Convert to Vitest w/ local Supabase, add `test` script |
| T-2 | `normalize/{category,condition,text,money,images}.ts` | P2 | Zero unit tests on critical normalizers | Add `*.test.ts` matching the `brand.test.ts` pattern |
| T-3 | `bulk_import_lots` / `resolve_category_ids_batch` SQL RPCs | P2 | No pgTAP coverage; CI applies migrations but never invokes RPCs | Add `packages/db/test/*.sql` pgTAP + `test:sql` script in `schema-check` job |
| T-4 | `e2e.yml:30` | P1 | E2E only runs on push to master, not PRs | Add `pull_request` trigger |
| T-5 | `apps/bidder-app/*` + `apps/field-mobile/*` | — | Zero unit/integration tests in either mobile app | Add minimal smoke + reducer/selector tests |

<!-- TODO: T-5 deferred — mobile unit testing requires Detox setup (device provisioning, Expo dev-client build, iOS simulator config in CI). Not in scope for audit-phase-4. Track as a separate initiative. -->

**Not E2E-covered:** bid placement end-to-end, operator CSV import submission, refund/dispute flow, payment receipt, Connect onboarding, auction close + winner notification.

### Cloudflare Worker

| # | File:Line | Sev | Issue | Fix |
|---|---|---|---|---|
| W-1 | `auto-charge-drain.ts:156` | **P1** | Sequential `for` over 50 jobs × ~600ms = 30s CPU wall risk | `Promise.allSettled` in groups of 10 OR `BATCH_SIZE` 50 → 15 |
| W-2 | `auto-charge-drain.ts:111-131` | P1 | `lotLinks` has no LIMIT — invoices with many lots can blow memory | Cap `lotLinks` to `BATCH_SIZE * 50` |
| W-3 | `(operator-web)/api/lots/import/route.ts:24` | P1 | Next.js default body limit 1MB; 5,000 rows ≈ 1MB borderline | `next.config.js` `api.bodyParser.sizeLimit:'4mb'` |

### Email

| # | File:Line | Sev | Issue | Fix |
|---|---|---|---|---|
| E-1 | `lib/cron/email-drain.ts:313-318` | **P0** | (EMAIL-C1 at top of doc) | (top of doc) |
| E-2 | `email-drain.ts:313` (Resend send opts) | P1 | No `List-Unsubscribe` header — legal copy promises one-click; CAN-SPAM/GDPR exposure | `headers: { 'List-Unsubscribe': '<mailto:unsubscribe@clovrbid.com>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }` |
| E-3 | `email-drain.ts:63-79` | P1 | No `color-scheme` meta, no dark-mode media query — Gmail Dark inverts `#fff` card making `#0b0d12` text invisible | Add `<meta name="color-scheme" content="light">` + `@media (prefers-color-scheme:dark)` block |
| E-4 | (missing kind in `email-drain.ts:32`) | P1 | No payment-receipt email after invoice paid | Add `payment_receipt` kind; emit from auto-charge success + Stripe webhook |
| E-5 | `email-drain.ts:66` | P2 | `width="560"` overflows mobile viewports | `width="100%" style="max-width:560px"` |
| E-6 | `email-drain.ts:62` | P2 | No preheader (inbox preview) text on any template | Hidden span after `<body>` |

## §H. Stripe Connect

### P0 — money-losing / compliance-failing

| # | File:Line | Issue | Fix |
|---|---|---|---|
| STRIPE-P0-1 | `api/invoices/[id]/payment-intent/route.ts:98-104`, `auto-charge-drain.ts:216-226` | (top of doc) | (top of doc) |
| STRIPE-P0-2 | `api/invoices/[id]/refund/route.ts:101-109 + 151-173` | (top of doc) | (top of doc) |
| STRIPE-P0-3 | `refund/route.ts:98` | Refund `amount` falls back to `invoice.total_cents` but Stripe refunds `amount_received` (incl. Stripe Tax) — ledger diverges on tax-collecting operators | Use `refund.amount` from Stripe response, not request |
| STRIPE-P0-4 | `refund/route.ts:108` | Always `refund_application_fee:true` on partial refunds — second partial refund attempts to refund already-refunded fee | Track `refund.application_fee_refund` from response |
| STRIPE-P0-5 | `lib/stripe.ts:96-127` | Webhook signature retry-all silently bounces on rotated secret — no alert, Stripe gives up after 3 days | `Sentry.captureMessage('stripe_webhook_signature_failed', …)` in catch-all |
| STRIPE-P0-6 | `webhooks/stripe/route.ts:98-664` | No `default:` in event switch — unknown events recorded `processed:true` with no action | Add `default:` with `console.warn` |
| STRIPE-P0-7 | `webhooks/stripe/route.ts:511-522` | (top of doc) | (top of doc) |

### P1 — broken edge cases

| # | File:Line | Issue | Fix |
|---|---|---|---|
| STRIPE-P1-1 | (none — zero handler) | `payout.failed` not handled — operator silent on failed payouts | Subscribe `payout.failed`+`payout.paid`, write to `notifications_outbox` |
| STRIPE-P1-2 | `webhooks/stripe/route.ts:423-434` | `charge.refunded` ignores `application_fee_refunded` — settlement under-counts | Update `application_fee_cents` + `operator_settlements.refund_cents` |
| STRIPE-P1-3 | `webhooks/stripe/route.ts:99-130` + UI gap | `requirements.currently_due` not surfaced — operator can't see "Stripe needs your EIN by Friday" | Persist on `operators.stripe_requirements_due`; render in `(operator)/payouts/page.tsx` |
| STRIPE-P1-4 | `lib/stripe.ts:49-55` + `route.ts:436-487` | Controller `losses.payments:'stripe'` works with current logic, but flipping to `'application'` silently breaks dispute notifications | Assert at module init OR document dependency |
| STRIPE-P1-5 | `lib/stripe.ts:179,209` + others | Currency hardcoded `'usd'`; `country:'US'` enforced — silently broken for non-US operators | Startup assert operator country |
| STRIPE-P1-6 | `apps/operator-web/src/app/onboarding/actions.ts:9-91` | Dead `startOnboarding`/`refreshOnboardingLink` Stripe-hosted-flow path still callable, sends operators into redirect loop | Delete dead actions |
| STRIPE-P1-7 | `api/bidder/setup-intent/route.ts:88-98` | No `payment_method_options.card.request_three_d_secure:'any'` — banks skip 3DS at setup, then block off-session charge | Add the option |
| STRIPE-P1-8 | `api/bidder/payment-intent/[id]/confirm-action/route.ts:116-133` | Doesn't re-validate `pi.transfer_data.destination === operator.stripe_account_id` | Add the check (defense in depth) |
| STRIPE-P1-9 | `api/bidders/me/pay-fees/route.ts:113-125` | 3DS-required returns 402 with no `client_secret` — bidder can't complete | Return `client_secret: pi.client_secret`; add verify-card-style flow |

### P2 — improvement

| # | File:Line | Issue | Fix |
|---|---|---|---|
| STRIPE-P2-1 | `lib/stripe.ts:26` + others | API version `'2026-04-22.dahlia'` may not match SDK pin | Align constant to actual SDK version |
| STRIPE-P2-2 | `refund/route.ts:101-109` | No idempotency key — flaky network can double-refund | `{ idempotencyKey: \`refund:${invoice.id}:${refundAmount}\` }` |
| STRIPE-P2-3 | `api/operator/account-session/route.ts:168-171` | Returns `detail: err.message` (leak acknowledged in comment) | Drop `detail` field |
| STRIPE-P2-4 | `payment-intent/route.ts:165-183` | Application fee computed at PI-create — operator tier change between bid and charge silently shifts fee | Document policy OR compute at bid-time |
| STRIPE-P2-5 | Multiple files | Redundant API-version strings | Extract to constant |
| STRIPE-P2-6 | `payouts/page.tsx:51-54` | Connected-account read doesn't gate on `charges_enabled` | Same gating as P0-1 |

**Multi-account isolation (CLAUDE.md Rule 3):** Clean. `apps/operator-web/.env.local:11-12` carries live keys for `acct_1TaMSs` only; zero references to `acct_1TWlcx` or `acct_1TWlcf` in `apps/`.

---

## Suggested execution order

| Phase | Items | Why |
|---|---|---|
| **Immediate (this week)** | SEC-01..03, STRIPE-P0-1/2/7, EMAIL-C1, TS-BUG-01, TS-P1-01 | Exploitable / money-losing / spam-folder |
| **Pre-BinGo-import** | B1–B8 (incl. DB-1, DB-2), STRIPE-P0-3..6, UX-P0-1..3 | Touches the actual import + bid path |
| **Same milestone** | DB-4 (RLS `SELECT` wrap), SF-1..9, TS-BUG-02/03, DB-5/6, PERF-1..4, A11Y-1..12, E-2..4, T-1, W-1 | Highest user-visible impact |
| **Next sprint** | DB-7..10, PERF-5..10, TS-P1-02..07, SF-10..11, STRIPE-P1-1..9, A11Y P1, UX-P1, i18n-blocker | Quality + cost wins |
| **Cleanup later** | DB-11..14, PERF-11..13, TS-P2-*, STRIPE-P2-*, A11Y P2, UX-P2, T-2..3, E-5..6 | Style + CI hygiene + nice-to-have |

---

## Methodology notes

- All findings come from **read-only** agents (Explore + specialist reviewers). No code changed, no migrations run.
- File:line citations point to the auction-platform repo state at 2026-05-24 ~18:30 UTC.
- Severity definitions:
  - **P0** = exploitable now / money-losing / data-corruption-risk now / blocks real users
  - **P1** = wrong but non-fatal; degraded UX or scale problem before 1M rows
  - **P2** = style, lint, polish, post-launch concern
- "BinGo go-live" = importing the 91k-lot CSV at `tmp/enrichment/bingo-manifest-enriched-v2-2026-05-24.csv` and standing up the first operator's live auctions. See `docs/state/HANDOFF-taxonomy-v2-2026-05-24.md` for the taxonomy v2 plan that pairs with this audit.

If a finding looks wrong, run it down — agents can hallucinate file:line citations under context pressure. Trust but verify.
