Superseded 2026-10-08: the owner rejected Floor Ledger; see DIRECTIONS.md. A new pick is pending the owner.

# Art direction · A / Floor Ledger

Stage A decision, not an implemented interface. Mockups are offline specimens with Sample data. Numeric placeholders deliberately show no real or invented operational metrics.

## Delivery model

Owner decision for Stage A2: no preview environment and no dev DB. Ship small PRs to **production**, each deployed in a **9–4 window**, behind a persisted per-browser cookie toggle. Visiting any console URL with `?ui=v2` enables v2; `?ui=v1` disables it; default is off. Off means every route renders exactly as today. With v2 on, routes not yet redesigned render their existing page content unchanged inside the v2 shell.

PR 1 = tokens + `/design-system` gallery + toggle (#451). PR 2 = shell (sidebar/nav and global lookup) + lot detail + lookup. Then pickups (PR 3), inventory tables (PR 4), dashboard Floor Story (PR 5), and the rest (PR 6+). Owner and Jared test each deployed screen on the live site with the toggle on. A screen becomes default-on only after **both** approve; approval of one screen does not enable all routes.

This replaces Stage A references to a dev-environment gate and the earlier rollout sequence in BRIEF.md/TOKENS-PLAN.md. It also narrows token/alias application: v1 and unchanged legacy page content must retain today's styling; v2 aliases apply only to opted-in redesigned surfaces. Stage A specimens remain historical studies, not production claims. [SHELL.md](SHELL.md), [LOT-DETAIL.md](LOT-DETAIL.md), [COVERAGE.md](COVERAGE.md) and [CONTRACT-CHANGES.md](CONTRACT-CHANGES.md) define Stage A2. The 1024 shell uses the collapsible full-navigation drawer specified in SHELL.md.

## Three directions, different operating models

### A · Floor Ledger — selected

[directions/a-floor-ledger.html](directions/a-floor-ledger.html)

A fixed navigation spine, a horizontal process index and a ruled ledger. Identity stays at one x-coordinate; exceptions have a labelled side band; finance is a separate reading beat. System sans for tasks, strong system monospace for stickers and aligned money. Moderate density: 64px two-line lot rows, 44px controls, 16px body. Tablet keeps the ledger and shortens the navigation rail rather than compressing type. Motion is a brief rule/color change; nothing floats or pulses.

Floor fit: strongest balance of touch area and visible work. Scanability: primary sticker, secondary BIN and status occupy predictable columns. Distinctiveness: a narrow orange index rule and repeated physical-label block connect dashboard and lot detail. Feasibility: existing dark brand roles, shared console primitives, CSS grid and native links. Performance: no imagery dependency, no chart runtime, no continuous animation. Risk: dark surfaces need a glare test; a compact tablet rail needs full destination access in implementation.

### B · Signal Desk

[directions/b-signal-desk.html](directions/b-signal-desk.html)

Light graphite/blue operations terminal. Top navigation, a compact matrix of count cells and a paired queue/inspector workspace. Monospace throughout; 14px body, 16px code; 56px two-line rows with 44px buttons. At 1024 the inspector stacks below the ledger; the matrix remains a compact band. More information shares a baseline; fewer section introductions. Instant state changes with a 100ms background acknowledgement, never flashes or tickers.

Floor fit: efficient for office keyboard use, busier at arm's length. Scanability: best simultaneous numeric comparison, weaker distinction between code and metadata because both are monospaced. Distinctiveness: strong desk-tool character. Feasibility: straightforward CSS; more column-priority decisions. Performance: equally light, but denser markup. Not chosen because touchscreen floor use needs a stronger identity hierarchy than an all-mono matrix.

### C · Dispatch Cards

[directions/c-dispatch-cards.html](directions/c-dispatch-cards.html)

Warm paper, dark forest ink, serif section titles and large monospace label cards. A top masthead replaces the sidebar. Each beat is a task packet with more spacing; closing lots are cards, not rows. 17px body, 20px codes, 48px actions; three cards across at 1440, two at 1024. Lot detail reads like a warehouse docket with identity at top, evidence in the middle, decisions at the foot. Motion would gently reveal a border over 180ms, with content always present.

Floor fit: comfortable touch and clear single-item inspection. Scanability: strongest local focus, weakest cross-row comparison. Distinctiveness: unusually tactile, document-like. Feasibility: CSS only, but introduces a light workspace against today's dark palette. Performance: no asset cost; more vertical travel. Not chosen because auction building and inventory audit need repeatable ledger coordinates over repeated large cards.

## Thesis

**Read the box. Find the record. See the next safe action.**

The physical sticker is the visual anchor. BIN remains readable beneath it. A missing sticker is a labelled exception, not a blank primary field. Structure follows operational work rather than a grid of equal-weight KPI cards. Normal states stay quiet; exceptions use words and deliberate color. The process index is navigation, not a funnel or evidence of completion.

## Palette and contrast

Single dark console scheme, preserving the existing dark character; no new light/dark switch. Current evidence: `apps/operator-web/src/app/globals.css` has a dark root palette and no alternate mode. B/C are alternate art studies, not extra themes to implement.

Contrast below is computed from opaque sRGB hex pairs using relative luminance `(Lmax + 0.05)/(Lmin + 0.05)`. Every permitted text pair clears 4.5:1 for normal text. Values are design calculations, not a live accessibility audit. Never lower text opacity to create a secondary label; use the specified opaque dim ink.

- `ink` #f4f7fb on bg/surface/raised/hover: #111d2c → 15.81:1, #192a3d → 13.57:1, #22364d → 11.48:1, #293f57 → 10.06:1.
- `ink-secondary` #b8c7d9 on bg/surface/raised/hover: #111d2c → 9.88:1, #192a3d → 8.48:1, #22364d → 7.17:1, #293f57 → 6.28:1.
- `ink-dim` #a0b2c8 on bg/surface/raised/hover: #111d2c → 7.85:1, #192a3d → 6.73:1, #22364d → 5.69:1, #293f57 → 4.99:1.
- `link` #7cd5ef on bg/surface/raised/hover: #111d2c → 10.21:1, #192a3d → 8.77:1, #22364d → 7.41:1, #293f57 → 6.50:1.
- `on-action` #111d2c on `action` #ffab52: **9.06:1**.
- `on-action` #111d2c on `action-hover` #ffbf7b: **10.51:1**.
- `on-action` #111d2c on `action-active` #f59a3e: **7.75:1**.
- `action` #ffab52 on `action-bg` #3a3027: **6.86:1**.
- `link` #7cd5ef on `info-bg` #203b4b: **7.06:1**.
- `warning` #ffd18a on `warning-bg` #3b3020: **9.04:1**.
- `danger` #ff9ca3 on `danger-bg` #402731: **6.79:1**.
- `success` #8be0b2 on `success-bg` #203d35: **7.53:1**.
- `neutral` #c1ccdb on `neutral-bg` #26394e: **7.27:1**.
- `link-hover` #afeaff on `surface-hover` #293f57: **8.25:1**.

- Background `#111d2c` anchors the shell; surface `#192a3d` holds records; raised `#22364d` separates controls; hover `#293f57` changes a row without moving it.
- Border `#425a73` is a decorative separator only. Strong border `#7c92aa` marks interactive boundaries; its lowest contrast against the allowed backgrounds is 3.37:1. Do not use the faint border as the only input boundary.
- Focus `#ffd18a` is a 2px ring with 3px background-colored offset; minimum contrast against those surfaces is 7.59:1. The offset separates it from an orange button.
- Orange means the current action or live sale, not every heading. Cyan is navigation/information. Amber means attention/waiting. Rose means a blocked or harmful outcome. Green means the labelled resolved state only. Text distinguishes sold, paid and handed over.

## Type, grid and density

- Body: `-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif`. Codes/money: `ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace`. No font request is needed. App font changes remain scoped to the console; do not remove fonts used by public pages.
- Type: 12px compact metadata; 14px secondary identifier; 16px body/action; 18px section heading and row sticker; 24px page heading; 32px detail identity and major count. Line heights: 1.2 headings, 1.4 controls/codes, 1.5 body. Code weight 700; body 400; headings/actions 650–700. Uppercase is for short region labels only.
- Desktop 1440: navigation 192px; content padding 24px; working width 1200px; inner 12-column grid, 16px gaps. Dashboard ledger/exception split 8/4; detail evidence/action split 8/4. Align code origins across repeated rows.
- Tablet 1024: navigation 112px with complete short text labels; padding 20px; working width 872px; 8-column grid, 12px gaps. Dashboard ledger and exception strip stack in document order; detail actions move below evidence. No scaling down the desktop canvas. Full navigation gets an explicit “All routes” control in implementation.
- Under 900px: retain the existing shell's accessible drawer concept; do not bake fixed specimen widths into product CSS. At 200% zoom reflow sections; long tables get a named local scroll region and keep identity available.
- Lot rows: minimum 64px so sticker and BIN have independent lines. 18px primary code, 14px secondary. Numbers right-align, use tabular digits. Title wraps before identity shrinks. Long sticker strings wrap at safe boundaries without truncation; full accessible text remains intact.
- Touch controls: minimum 44×44px even in compact tables; 8px between adjacent destructive/primary actions. Empty/loading/error blocks reserve useful space, never pretend to be records.

## Shape and imagery

Square composition with 4px input/action corners, 6px panel corners and 999px only for compact status pills. Borders and alignment carry grouping; no floating card grid, gradients, glass or ornamental hero. The signature is a 3px orange left rule beside the physical label, repeated on the current Floor Story beat.

Use existing lot photography only where it helps identify an item; contain it, preserve the whole box/label and allow the existing lightbox. No stock imagery, decorative warehouse photo or generated product evidence. Stage A uses a plain “Photo placeholder” panel; it never implies an image was inspected. No customer names, contact details, card data or worker identities appear in mockups.

## Motion contract

- `--console-duration-instant: 0ms`; `--console-duration-fast: 120ms`; `--console-duration-base: 180ms`; `--console-duration-slow: 240ms`.
- `--console-ease-standard: cubic-bezier(0.2, 0, 0, 1)`; `--console-ease-enter: cubic-bezier(0.16, 1, 0.3, 1)`; `--console-ease-exit: cubic-bezier(0.4, 0, 1, 1)`.
- Hover/focus colors: fast/standard. Optional current-beat rule: base/standard. Dialog backdrop: base/enter, fast/exit, without moving its focus target. Slow is reserved for a nonessential expanded region's color transition, never a delayed action.
- No count-up numbers, pulsing live dots, layout-moving KPI hover, parallax, auto-advance, sounds, scroll snap or intercepted wheel/touch/key events. Transaction completion waits for a real server result, never a timer.
- `prefers-reduced-motion: reduce`: all duration tokens become 0ms; no transform/opacity reveal, no pulses or smooth scroll. Labels and static focus rings remain. Content is never hidden pending animation. Static HTML specimens deliberately contain no animation.

## Signature experience · Floor Story

A dashboard that reads as successive, useful sections of the day's work. The index reads **Intake → Lotting → Auction → Paid → Pickup**, followed by **Exceptions**. Intake and Lotting are navigation destinations only for returning users; they have no fabricated backlog counts. Numbered beat labels are document order, not live progress. Beat changes do not imply work was completed.

1. **Orient / find the box.** See page title, explicit dashboard scope, lookup input and process index. On first-run only, preserve existing setup checklist driven by current predicates. On scroll the lookup/index can stay sticky within normal document flow, with reserved height. Learn where to start, not a made-up completion percentage. Act: lookup via `/lots/lookup?code=…`, intake via `/imports`, lotting via `/lotting/inventory`.
2. **Auction / what is moving.** See live-lot count, scheduled-auction count and up to eight closing-soon records in the existing order. On refresh, replace values directly; no animated rise. Learn which sale records close next, with each warehouse's time context. Act: open an exact lot or `/auctions`. Current live-lot KPI links to `/lotting/inventory`, which is not an exact live filter: use a non-clickable number plus an honestly labelled “Open auctions” link until a valid filtered destination is verified. Sticker-first closing rows require the identity fields noted below.
3. **Paid / what money means.** See Collected · 7 days (incl. tax), Net revenue · 7 days (excl. tax), Platform fees · 7 days, plus Unpaid invoices in the attention band. As this section enters view, an optional narrow index rule changes color over 180ms; numbers stay still. Learn gross/net distinction and unpaid work without a conversion ratio. Act: `/reports/money` and `/invoices?status=unpaid`. Fees retain the current invoice destination with an explicit label, not a claim of fee reconciliation.
4. **Pickup / what is scheduled.** See Today's pickups with permanent subtitle “Scheduled today · pending or scheduled”; a link reads “Open all pickups”. Scroll normally into the section; no takeover. Learn that this is appointments, not all work at the counter. Act: `/pickups`, where checked-in, waiting and missing-item work already lives. Do not create a dashboard “At counter” count from this query.
5. **Exceptions / where to intervene.** See Open disputes, Resale certs pending and Unpaid invoices as separate labelled counts. No total “blocked” score: the units and populations differ. The selected section's rule may change on scroll; no sticky alert covers the content. Learn which existing queue to open. Act: `/disputes`, `/bidders?filter=resale_pending`, `/invoices?status=unpaid`.

Desktop may place the exceptions beside the auction ledger while retaining this DOM reading order; at 1024 it becomes a full-width strip after the working sections. The static mockup compresses beats into one reviewable Dashboard frame, with headings identifying each beat. It is a snapshot of the experience, not a playback demonstration.

**Static fallback:** all sections, numbers, caveats and ordinary links are server-rendered and readable in order. Optional current-section highlighting is progressive enhancement only; without JavaScript the whole story remains usable. Standard anchor navigation with `scroll-margin-top` and normal browser scrolling. No height-locked panels or hidden narrative steps.

**Reduced-motion version:** same content and order, immediate anchor jumps, no transitions. Any optional active-section state updates immediately, without live announcements on every scroll. No visual effect is required to understand or act.

## Existing dashboard number contract

Source: `apps/operator-web/src/app/(operator)/dashboard/page.tsx`; these are query definitions, not observed live values. No warehouse selector is invented: these main counts use the existing client scope, while pending resale certificates use the admin client. No automatic polling or freshness timestamp is asserted.

### Six operational counts

- `liveLotCount`: exact HEAD count of `lots`, `status = live`.
- `scheduledAuctionCount`: exact HEAD count of `auctions`, `status = scheduled`.
- `todayPickupCount`: exact HEAD count of `pickups`, `scheduled_at >= startOfDay` and `< endOfDay`, status in `pending, scheduled`; JavaScript server-local day boundaries serialized to ISO.
- `openDisputeCount`: exact HEAD count of `disputes`, `status = open`.
- `resaleCertPendingCount`: admin-client exact HEAD count of `bidders`, `resale_cert_status = pending`; no explicit operator filter in this query.
- `unpaidInvoiceCount`: exact HEAD count of `invoices`, status in `pending, payment_failed_grace, payment_failed_relisted, unpaid_no_show`.

### Four money computations from one invoice result

The query includes statuses `paid, partially_refunded, refunded`, and `paid_at >= now - 7 × 86,400,000ms`. It selects `total_cents, tax_cents, application_fee_cents, paid_at, refunded_cash_cents, refunded_credit_cents, refunded_tax_cents`. It has no explicit upper bound or pagination in this file; completeness under backend limits must be checked before treating this as audited accounting.

- `weekGmvCents = Σ max(0, total_cents − refunded_cash_cents − refunded_credit_cents)`; shown as Collected · 7 days (incl. tax).
- `weekTaxCents = Σ max(0, tax_cents − refunded_tax_cents)`; already computed, currently not a standalone card. Do not add a new card in Stage B merely because it is available.
- `weekNetRevenueCents = max(0, weekGmvCents − weekTaxCents)`; shown as Net revenue · 7 days (excl. tax). This formula does not subtract platform fees; do not relabel it profit or payout.
- `weekFeeCents = Σ application_fee_cents`; shown as Platform fees (7 days). No additional refund adjustment is applied to fees in this computation. Null monetary fields default to zero in the current code.

### Five setup counts, not work-in-progress measures

- `warehouseCount`: all warehouses visible to the current client.
- `warehouseWithFloorPlanCount`: warehouses with non-null `floor_plan_url`.
- `binCount`: all bins visible to that client.
- `anyLotCount`: all lots visible to that client; not “stock awaiting put-away”.
- `scheduledOrLiveAuctionCount`: statuses actually include `scheduled, live, closed`, despite the variable name. It supports the setup predicate, not an active-auction KPI.

The checklist converts these to `> 0` booleans and combines a conditional tax acknowledgement step; the setup banner is hidden when complete. Preserve that behaviour rather than presenting these lifetime counts as a flow funnel.

### Closing-soon row numbers and timing

`recentLive` selects `id, title, current_bid_cents, bid_count, close_at, status, warehouses(timezone)`, filters `live/scheduled` and non-null close time, orders ascending by close time and limits to eight. Row displays are current bid, bid count and formatted closing timestamp. The query does not explicitly filter out past close times. Retain truthful ordering and do not call it a real-time stream.

**Identity dependency:** no sticker, BIN or `display_code` is selected here today. The specimens show clearly fictional identity labels to illustrate the requirement. Future selection must supply `lot_code, sticker_code, display_code` and use `lotDisplayCode`, including lineage semantics; this is a data-field addition, not a new metric, but outside Stage A. If blocked, show a loading/unavailable identity state; never infer a sticker from a title.

### Nested dashboard reports, intentionally outside Floor Story

`dashboard/workers/page.tsx` separately loads PIN-worker lots today/7d/30d, relots30d, days worked, per-day/per-hour rates and attribution coverage; sign-in account lots created 7d/30d, dropped rows 7d, staging scans 7d/30d and attributed GMV 30d plus totals. These are report-specific, not available in the main dashboard's query result. `dashboard/workers/daily/page.tsx` calls `worker_daily_productivity` for worker/day lot cells, then row totals, day totals and grand total. Do not copy worker statistics into Floor Story or change their access gates. Main dashboard only provides an admin-only link to Worker productivity.

## Next-stage verification

Verify every status with entity context; `paid` belongs to invoice state and “handed over” to item fulfillment, not one universal lot-status enum. Verify negative cases for guarded actions: disallowed role, footprint present, duplicate click before re-render, wrong typed code. Recheck actual 1024/1440 layouts, keyboard focus, reduced motion, zoom and contrast after implementing aliases. No speed, conversion or customer-impact improvement is claimed without observation.

## References — observed screens, principles only (2026-10-12)

Round 6 rules for G / Nightshift, grounded in the nine supplied screenshots. These are public marketing pages, not authenticated dashboards. Stripe is light; Vercel does not demonstrate a full status-pill system. Take principles only: no copied layouts, assets, logos or copy. The Floor Ledger study above remains historical; Nightshift's fonts, code face and stage semantics stay locked.

### Linear
Files: `linear-home.png`, `linear-home-scrolled.png`, `linear-features.png`.
- L1 — `linear-home.png` shows a near-black page, a lighter app panel and darker inset content; separate Nightshift's page, section and inset card with distinct violet fills.
- L2 — `linear-home.png` puts a large headline above small, quiet supporting text; retain the locked display/body hierarchy and sticker-first row hierarchy.
- L3 — `linear-home-scrolled.png` separates three figures with fine vertical rules; use quiet boundaries to group console work without heavy outlines everywhere.
- L4 — `linear-features.png` pairs green/yellow markers with written category labels; keep every stage and status named, with colour as a second cue.
- L5 — `linear-features.png` contains its graphics inside rounded panels; contain console colour and decoration within rounded sections, leaving operational text unobscured.

### Raycast
Files: `raycast-scrolled.png`.
- R1 — `raycast-scrolled.png` nests the clipboard window and dock within a darker outer frame; keep inset work cards darker than their enclosing violet sections.
- R2 — `raycast-scrolled.png` outlines the main frame with a fine illuminated edge; use a thin section top edge, keeping the readable fill opaque.
- R3 — `raycast-scrolled.png` gives the selected clipboard dock button the strongest edge glow; reserve the urgent pulse for Pickup and keep other rows calm at rest.
- R4 — `raycast-scrolled.png` uses a tinted selected clipboard row while the other rows remain dark; retain the current-stage tint and explicit selection cues.
- R5 — `raycast-scrolled.png` aligns compact information labels and values under the colour preview; retain compact record facts with consistent text alignment and readable metadata.

### Vercel
Files: `vercel-home.png`, `vercel-scrolled.png`, `vercel-dashboard-marketing.png`.
- V1 — `vercel-home.png` places white actions on a mostly black field; preserve a dark console base so eligible primary actions stand out.
- V2 — `vercel-home.png` pairs a filled primary button with an outlined secondary button; keep the console's primary, secondary and unavailable actions visibly distinct.
- V3 — `vercel-dashboard-marketing.png` shows grey Pro/Enterprise plan pills and one red alert chart, not a full status-pill system; retain Nightshift's existing labelled status tokens without attributing them to Vercel.
- V4 — `vercel-dashboard-marketing.png` names the endpoint, error percentage and investigating state beside the red chart; keep exception labels and counts explicit rather than relying on warning colour.
- V5 — `vercel-scrolled.png` separates its large section heading from compact feature links; keep task headings distinct from smaller actionable row content.

### Stripe
Files: `stripe-home.png`, `stripe-scrolled.png`.
- S1 — `stripe-home.png` and `stripe-scrolled.png` have light page and card surfaces; borrow their hierarchy, not a supposed dark-surface palette.
- S2 — `stripe-home.png` concentrates its gradient in a sweeping hero band and `stripe-scrolled.png` contains gradients within illustrations; keep Nightshift gradients in header bands and opaque fills behind dense records.
- S3 — `stripe-home.png` separates a large headline, short supporting label and compact buttons; preserve Nightshift's locked font families while maintaining distinct heading, metadata and action sizes.
- S4 — `stripe-scrolled.png` gives each card a clear title above its detailed illustration; keep console section titles above their records and actions.
- S5 — `stripe-scrolled.png` keeps chat, product and payment details legible inside larger cards; keep item, customer and invoice details at least 13px in the tablet missing-item row.

Applied in round 6: L1/R1 raise enclosing section fills with an approximately 8% white tint while keeping inset cards darker (item 6); R2 confines section edge light to a thin top edge; S2 retains header-band gradients over opaque record surfaces. V2 informs the dashed, dimmed unpaid action (item 2); R3 keeps the earlier visible Pickup pulse singular (item 5); S5 raises tablet missing-item metadata (item 8). The other rules preserve existing behaviour, typography and stage colours.

## Three refs (2026-10-13)

Braden's art direction for every v2 page from here on. Files: `refs/shadcn.png`, `refs/analytics.png`, `refs/hud.png`. Each ref supplies one thing. G / Nightshift's locked decisions (fonts, navy palette A, stage hues, status by meaning, workflow first) still win wherever a ref disagrees.

### What we take, and what we leave

| Ref | Take | Leave |
|---|---|---|
| **shadcn = structure** (the skeleton for every page) | Sidebar with grouped sections and the user card at the bottom; a stat-card row, each card with a trend pill **only when real data has a comparison period**; tab pills; a dense table with status pills and row actions; a page header with **one** primary button top-right. | Its monochrome palette and grey-on-black chart; checkbox columns and drag handles we have no use for; "Customize columns", "Add section" and pagination controls unless a page really has them; invented trend copy ("Trending up this month"). |
| **analytics = warmth** | Navy base; 16px rounded cards; one bright accent (our lime); soft elevation instead of hard borders; pill segmented controls; area charts with a gradient fill fading to nothing. | Its blue/violet accent and violet chart fills; the currency/flag/avatar header furniture; the light/dark switch; decorative donut charts; red/green for good/bad money. |
| **hud = sparingly** | Small uppercase labels over values (Atkinson Hyperlegible, tracked, not a mono font); a corner-bracket frame on the active/urgent card **only**; a live status chip in the header built from real data ("Live · 24 at the counter"); a faint grid texture (~3% opacity) on the page root; one scan-line reveal on the dashboard floor story. | Cyan, glow-on-everything, every-panel brackets; sci-fi copy ("SYS_", "NEURAL", "PROGNOSIS", underscores in labels, `[F1]` key hints); fake telemetry (latency, "ONLINE :: 12ms", logs that scroll); anything that loops. |

### Page skeleton (shadcn structure on our pages)

Every page reads top to bottom in this order. Workflow first: the floor/counter work leads; money and reports follow.

1. **Shell** (shared, `_shell-v2`): grouped sidebar (sections already match nav-model.ts) with the operator/user card at the bottom; header shows where you are. The live chip belongs to a page header, not the shell, until a shell-wide real signal exists.
2. **Page header**: mono label (section · date), Syne title, one sentence of purpose, live chip when the page has a real live count; **one primary button top-right** pointing at a real action. Lime stays the floor action inside the page; the header's primary uses the solid neutral button (`console-v2-btn--solid`) so a page never shows two lime buttons.
3. **Stat row**: 3–4 warm cards, mono label over a Syne value, one-line definition. Trend pill only with a real comparison; otherwise no pill.
4. **Work** (the page's floor story / queue / table): tab pills or segmented control only where the page already filters; dense table with status pills by meaning and row actions at the right.
5. **Later sections**: money, reports, history.

| Page | Header primary (top-right) | Stat row | Work (leads) | Hud accent |
|---|---|---|---|---|
| Dashboard | Look up a lot (`/lots/lookup`) | Live lots, scheduled auctions, today's pickups | Needs attention floor story (urgent stage first), Next to close table, Decisions waiting | Live chip = at the counter; brackets on the urgent stage card; scan-line on the floor story; grid texture |
| Lots (inventory) | An existing lot action (later run) | Existing inventory counts only | Tab pills (existing filters) + dense lot table, sticker-first | Brackets only on a lot needing action, if any |
| Lot detail | The lot's next safe action | Bid / status facts as mono label over value | Floor story Intake → Pickup | Brackets on the lot's current stage |
| Pickups | Find customer | Queue counts | Counter queue first, then missing items | Live chip = at the counter; brackets on the counter queue card |

Lots, lot detail, pickups and the shell are applied in later runs; the table is the plan, not current state.

### Rules (locked)

- Navy base (palette A, #477); lime is the one primary colour; stage hues from `stage-hue.ts` (#478); Syne display, Atkinson body and all codes. No mono font.
- Status pills by meaning. Scheduled and Sold pills are neutral grey `#d3d8e2` (Braden's call; draft #481 makes the change).
- Focus ring lime (`.console-v2-refs-page` sets `--console-focus` to lime on pages that opt in). Destructive actions use the coral outline (already the button-skin rule).
- No cyan, violet or lavender. No sci-fi copy. Labels are plain sentence words, uppercase by CSS only.
- Never invent numbers: no trend pill, chart or live chip without real data behind it.
- Motion: reduced motion is fully static (motion system #482). The scan-line animates opacity and transform only, runs once, ends invisible, and exists only under `prefers-reduced-motion: no-preference`.
- Brackets on one card per page at most (the urgent/current one, and only when it has work).

### Primitives (globals.css, `v2 three-refs` block)

Tokens: `--console-radius-card` (16px), `--console-elevation-soft[-hover]`, `--console-label-mono-*`, `--console-bracket-*`, `--console-texture-grid*`, `--console-live-*`, `--console-chart-area-*`, `--console-duration-scan`, `--console-ease-scan`, `--console-solid-*`.
Classes: `console-v2-refs-page`, `console-v2-texture-grid`, `console-v2-label-mono`, `console-v2-card-soft`, `console-v2-frame-bracket`, `console-v2-live-chip` (+ `__dot`, `__label`), `console-v2-trend-pill`, `console-v2-segmented` (+ `__option`), `console-v2-page-head` (+ `__titles`, `__meta`, `__actions`), `console-v2-btn--solid`, `console-v2-scanline`. Specimens on `/design-system` ("Three refs primitives").
