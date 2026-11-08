# G · Nightshift — build specification

2026-10-09 · Owner-directed F + E merge · Docs only · Sample data only.

## 1. Thesis and inheritance

Keep the floor’s sequence beside the work, with the box’s sticker and the next eligible action immediately readable.  
Use violet depth, luminous lime and expressive type to give that workbench character without adding a step to lookup, checkout or exception review.

**From F / Tideline:** full-width utility bar; floor-story pane on the left; task pane on the right; Intake → Lotting → Auction → Paid → Pickup; sticker-first identity; inline decisions. **From E / Afterglow:** dark violet foundation, pale high-contrast text and lime action accent. G adds stronger static gradients, tinted floating glass, bounded lime glow, more layered motion and a new Pickups screen. At 1024, the floor pane collapses to give the task the full width; this intentionally changes F’s persistent narrow split.

Build target for the separate implementer: **`docs/design/console-v2/directions/g-nightshift.html`**. This specification does not create that file. All visible prose, headings, empty/error states and fictional records come from [G-COPY.md](G-COPY.md). This document governs geometry and behavior; G-COPY governs strings and fixtures. Existing action labels and business definitions retain their meaning.

### Evidence and limits

Read as design inputs: [DIRECTIONS.md](DIRECTIONS.md), [F](directions/f-tideline.html), [E](directions/e-afterglow.html), [BRIEF.md](BRIEF.md), [SHELL.md](SHELL.md), [LOT-DETAIL.md](LOT-DETAIL.md), plus `apps/operator-web/src/app/(operator)/pickups/{page.tsx,buckets.ts,PickupActions.tsx,CustomerSearch.tsx,SessionsToggle.tsx,MissingItemsQueue.tsx}`. G supersedes the older appearance restrictions, not business predicates, authorization or data meanings.

PR #452 / `fix/pickups-counter-names`: **use the owner’s supplied description only**. `counter-rows.ts` is absent here; neither its implementation nor deployment was verified. The described addition is customer name + short invoice link + remaining owed lot identities in each counter row. Exact owed-item filtering is a future implementation dependency; CSS and invoice status must not infer it. Unknown owed data is an error state, never an empty owed list.

The current page loads open pending/scheduled/checked_in pickups separately (cap 1,000), recent completed/no_show pickups separately (cap 50), and unresolved missing outcomes separately (cap 50). Preserve bucket order and loaded-subset language. Checked-in wins over date; completed/no_show go to Recently done; other appointments in the server-local day go to Today; other open rows go to Waiting. Warehouse timestamps use warehouse timezone. Do not silently redefine the bucket boundary as warehouse-local or sort the counter differently: current query puts most recently checked in first. The seven-day dashboard money definitions and nine metric values are unchanged from DIRECTIONS.

All six frames are fictional, independent specimens. Dashboard’s live BRN4982227 and detail’s unsold BRN4982227 are expressly separate scenarios. Dashboard’s 18 appointments is a metric specimen; Pickups’ one Today row is a loaded-row specimen, not a contradictory claim of a complete list. No fabricated latency, trend, throughput, progress percentage, warehouse filter or “all clear” score.

## 2. Tokens

### Colour and contrast

Use these exact opaque sRGB values. Ratios below were calculated with WCAG relative luminance, `(Llighter + .05)/(Ldarker + .05)`, rounded to two decimals. Secondary text uses its own ink, **never opacity**. All normal text, including 12–15px metadata, must meet 4.5:1; meaningful control edges and focus indicators meet 3:1. Separators alone are decorative.

> **Palette change 2026-10-13 (Braden, option A — navy).** The violet surface values below are the frozen mockup's and are superseded in the shipped console. The live values are in the `[data-console-v2]` token block of `apps/operator-web/src/app/globals.css`: page `#0B1020`, section/rail `#151D33`, card/raised `#1F2A45`, bright/hover `#283553`, glass `#18213A`, line `#3C4C6E`, edge `#94A3C0`, secondary ink `#B8C1D6`, danger fill `#4B2833`, shadow ink `#04060D`. Lime, stage hues, status-by-meaning hues and body ink are unchanged. Every text/surface pair was re-checked at ≥4.5:1 (lowest 5.53:1, auction coral `#F29C98` on the active gradient endpoint `#2A3858`; secondary ink lowest 6.45:1); edge is ≥4.58:1 on every surface. This file and `directions/g-nightshift.html` are left as frozen.

| Token | Hex | Role / allowed placement | Verified contrast |
| --- | --- | --- | --- |
| `--g-page` | `#171221` | Sheet, frame foundation, input fill | Body 16.82:1; secondary 10.14:1 |
| `--g-section` | `#211A30` | Floor pane and section gradient endpoint | Body 15.34:1; secondary 9.25:1 |
| `--g-card` | `#2D233F` | Cards, rows, secondary buttons | Body 13.52:1; secondary 8.16:1 |
| `--g-bright` | `#3C2D52` | Brightest opaque header/selected surface endpoint | Body 11.40:1; secondary 6.87:1 |
| `--g-glass` | `#352843` | Solid floating-panel fallback | Body 12.54:1; secondary 7.56:1 |
| `--g-ink` | `#F8F3FF` | Headings, body, icons, links, neutral focus ring | Minimum 11.40:1 across opaque violet gradients |
| `--g-secondary` | `#C7BCD8` | BIN, hints, placeholders, time, disabled copy | Minimum 6.87:1 across opaque violet gradients |
| `--g-lime` | `#C8FA7A` | Primary button lower-luminance endpoint, active 3px rule, glow source | On-lime text 12.29:1 |
| `--g-lime-hi` | `#E1FFB7` | Primary button upper-luminance endpoint | On-lime text 13.54:1 |
| `--g-on-lime` | `#202B14` | All text/icons on lime buttons | Minimum 12.29:1 over full primary gradient |
| `--g-edge` | `#A599B8` | Input and secondary-button 1px boundary; radio/checkbox outline | 6.86 / 6.25 / 5.51 / 4.65:1 on page/section/card/bright |
| `--g-line` | `#655577` | Dividers, decorative panel borders | Decorative only; never sole input/selection cue |
| `--g-danger-bg` | `#4C293D` | Danger buttons, error inset | Danger text 9.05:1 |
| `--g-danger` | `#FFD0DC` | Danger text/icon and boundary on danger inset | 9.05:1 on danger fill |
| `--g-shadow-ink` | `#08050F` | Shadows only, alpha specified below | No text use |

**Glass worst case:** fallback `#352843` gives **12.54:1 body / 7.56:1 secondary**. The enhanced panel is 92% that colour over its backdrop. Even over solid white, its rounded composite is `#453952`, giving **9.82:1 body / 5.92:1 secondary / 4.00:1 control edge**. White is a conservative upper bound, including when a lime control scrolls behind it. Do not reduce the 0.92 tint alpha or add a light wash above it. No text is placed directly over a photograph or an unbounded transparent gradient.

Status tokens are opaque, including when used on glass. Render the text label and a 6px dot; colour is supplemental. Use these in normal, hover, focused and pressed states without recolouring the text:

| State / token suffix | Foreground | Background | Ratio | Meaning |
| --- | --- | --- | --- | --- |
| `inventory` | `#D4DFD8` | `#35423E` | 7.67:1 | `in_inventory` |
| `scheduled` | `#DBCBF7` | `#453858` | 7.09:1 | Scheduled |
| `live` | `#B9DCEC` | `#304652` | 6.83:1 | Live |
| `sold` | `#E2C5EF` | `#4B3555` | 6.94:1 | Sold; does not imply paid |
| `paid` | `#C8E1D0` | `#35483E` | 7.05:1 | Paid; does not imply handover |
| `handed` | `#C5DFE6` | `#32464D` | 7.11:1 | Handed over, only with item-level evidence |
| `missing` | `#F2C4AE` | `#513A32` | 6.64:1 | Missing; also `no sticker` identity warning |
| `disposed` | `#D7CFDE` | `#433C4B` | 6.98:1 | Disposed |

Token names follow `--g-live-fg`, `--g-live-bg`, etc. Unsold uses the scheduled pair with explicit **Unsold · run outcome** text; it is not a ninth replacement state. Pickup operational badges use inventory for Pending, scheduled for Scheduled, live for Checked in, handed for pickup Completed, missing for No-show, disposed for Refunded; the wording preserves the domain. Pickup Completed must not be reused as proof that every item was handed over. Partially refunded uses the sold pair and its full label; Unpaid uses missing. Unavailable states use secondary on card, not a fake status.

### Exact surfaces, glass and glow

```css
/* All gradient stops interpolate opaque sRGB channels; no blend modes. */
--g-gradient-frame: linear-gradient(135deg, #171221 0%, #211A30 100%);
--g-gradient-floor: linear-gradient(180deg, #2D233F 0%, #211A30 65%, #171221 100%);
--g-gradient-section: linear-gradient(135deg, #211A30 0%, #2D233F 100%);
--g-gradient-band: linear-gradient(110deg, #3C2D52 0%, #2D233F 65%, #211A30 100%);
--g-gradient-active: linear-gradient(100deg, #3C2D52 0%, #2D233F 100%);
--g-gradient-primary: linear-gradient(110deg, #E1FFB7 0%, #C8FA7A 100%);
--g-shadow-card: 0 8px 24px #08050F40, 0 2px 6px #08050F33;
--g-shadow-float: 0 20px 48px #08050F66, 0 4px 12px #08050F4D;
--g-glow: 0 0 0 1px #C8FA7A40, 0 0 20px #C8FA7A26, 0 6px 16px #08050F66;
```

Frame uses frame gradient; floor uses floor gradient; section wrappers use section gradient; identity and metric header bands use band gradient. Selected navigation, selected font label and current floor step use active gradient plus a 3px solid lime inset rule. Primary pill alone uses the lime gradient. No full lime hero or pale text on lime. Glow is confined to primary buttons and the selected rule’s decorative backing, never whole rows or every chip.

```css
.g-glass {
  background: #352843;
  border: 1px solid #A599B8;
  box-shadow: var(--g-shadow-float);
}
@supports ((backdrop-filter: blur(12px)) or (-webkit-backdrop-filter: blur(12px))) {
  .g-glass {
    background: rgba(53, 40, 67, 0.92);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
  }
}
```

Glass only on the floating top bar, the review controls and the toast. No blur on rows, the entire floor pane or beneath every card. No saturation/brightness filter, animated blur, animated gradient or blend mode. Put decorative glow behind the opaque control fill with `pointer-events:none`; it cannot change the text/background pair. Shadows appear/disappear via an independent pseudo-element’s opacity, not an interpolated `box-shadow`.

### Shape, rhythm and depth

- Box sizing: `border-box` everywhere. Frame dimensions include all content; use an inset decorative outline, not a width-changing border.
- Spacing scale: **4, 8, 12, 16, 20, 24, 32, 40, 48px**. Default card padding 20px; table/counter padding 16px; section gap 24px at 1440 and 16px at 1024; inline control gap 8px.
- Radii: frame and large section **24px**; glass bar and identity **20px**; card and counter row **16px**; input/photo **12px**; inset/error **8px**; pill/chip **999px**.
- Shadows: card shadow on stat tiles and bounded cards; floating shadow on glass only. Ordinary table rows have no shadow at rest. Hover backing uses `0 4px 12px #08050F4D`; pressed backing has zero opacity.
- Z-layers within each isolated frame: decoration **0**; normal content **1**; lifted row/card **2**; sticky floor content **10**; sticky top bar **30**; toast **40**; focus ring on its owning control **50**. No page-wide overlay or modal scrim. Focus must not be clipped by a neighboring stacking context.
- Motion aliases: `--g-ease-out:cubic-bezier(.16,1,.3,1)`; `--g-ease-standard:cubic-bezier(.2,.8,.2,1)`; `--g-ease-press:cubic-bezier(.3,0,.7,1)`; `--g-ease-shimmer:cubic-bezier(.4,0,.6,1)`; `--g-fast:120ms`; `--g-hover:160ms`; `--g-reveal:240ms`; `--g-page-in:280ms`; `--g-pane-in:360ms`; `--g-stagger:45ms`; `--g-chip:240ms`; `--g-count:1100ms`; `--g-shimmer:1600ms`.

## 3. Six frames and layout geometry

### Shared shell and sizing rules

Review sheet is a native-size, vertically stacked document. Order: **Dashboard 1440, Lot detail 1440, Pickups 1440, Dashboard 1024, Lot detail 1024, Pickups 1024**. IDs: `g-d1440`, `g-l1440`, `g-p1440`, `g-d1024`, `g-l1024`, `g-p1024`. Label and 32px gap before each frame. Frame height follows content and expanded disclosures; never crop to a fixed screenshot height. Width is exactly 1440 or 1024 CSS px. A narrow review viewport may horizontally scroll the sheet; there must be no horizontal scroll *inside* a stated-width frame. Do not scale frames with transforms.

Each frame: native top bar → optional notices in flow → split shell. Top bar is sticky `top:16px`, `z-index:30`, height 96px. Desktop margin `24px 24px 16px`; tablet margin `16px 16px 16px`. Frame overflow remains visible so sticky descendants work; clip only decorative background layers. The document is the vertical scroll owner; no nested work-pane scrolling. All anchor targets use `scroll-margin-top:128px`; the lookup specimen hint is not sticky; no smooth scrolling requirement. At viewport heights too short for a sticky floor pane, its own links may scroll vertically; main work must not.

Top bar has 15px vertical padding plus its 1px glass border; the 64px label/control stack therefore fits the 96px height exactly. Top bar inner grid at 1440: **148px brand / minmax(0,1fr) nav / 440px lookup / 116px sample badge**, with 16px gaps and 20px horizontal padding. Its 1392px outer width leaves 600px for nav. At 1024: **112px / 308px / 420px / 84px**, 12px gaps, 16px horizontal padding, within 992px. Border consumes 2px: subtract those 2px from the flexible nav track (598px desktop; 306px tablet). Brand 24px display weight 700; at 1024 omit the decorative brandmark, not the wordmark. Navigation uses body 15px bold, three 44px-high links with 12px horizontal padding, 8px gaps; active page gets rule + gradient + `aria-current="page"`. Lookup label 13px/16px; 4px below label; input/button 44px high. Sample badge may wrap “Sample data” into two lines at 1024; Find lot never wraps.

Notices are normally absent in these fixtures. In the state gallery show build notice then MFA notice full width in flow, not floating over work. Existing predicates remain outside this mockup. No login, sign-out, live feature flag or real settings action is simulated.

### Pane grid for every screen

| Frame | Horizontal grid | Left floor story | Right work composition |
| --- | --- | --- | --- |
| Dashboard 1440 | 24px gutter + **280px floor + 24px gap + 1088px work** + 24px gutter | Five ordered steps; Auction current; Pickup step links to pickup frame; no invented intake/lotting counts | Heading; three metrics; **752px closing table + 24px gap + 312px exceptions**; finance; motion/loading gallery |
| Lot detail 1440 | Same **280 / 24 / 1088** | Five stages with Lotting current; location inset; five record anchors | Identity; font controls; **640px evidence/ownership + 24px gap + 424px decisions**; notes; bids; timeline; conditional/state gallery |
| Pickups 1440 | Same **280 / 24 / 1088** | Five stages with Pickup current; four pickup-section anchors | Heading; search; pickup-pass strip; missing-item queue; counter; Today; Waiting; Recently done; invoice targets/state gallery |
| Dashboard 1024 | 16px gutter + **992px work** + 16px gutter; closed floor width **0** | 44px disclosure above work; open content described below | Three metrics; exceptions in three columns; full-width closing table; three money tiles; motion/loading gallery |
| Lot detail 1024 | Same **0 / 992** | Same disclosure; Lotting current, location and record anchors when open | Identity; Compare typefaces link; evidence + ownership full width; decisions full width; notes; bids; timeline; conditional/state gallery |
| Pickups 1024 | Same **0 / 992** | Same disclosure; Pickup current, queue anchors when open | Search and all four queues stay full width, in desktop order; no carousel or tab hides a queue |

Desktop floor aside has 20px padding inside its 280px width; 240px inner track. It uses `position:sticky; top:128px; align-self:start; max-height:calc(100vh - 144px); overflow-y:auto`. Disable its sticky/max-height when viewport height <600px. Floor steps have 12px gaps; each has a 44px link target and 16px inset. No progress track connecting the dots and no completion check marks. Local record/queue anchors follow the five stages, never replace them. The current stage means location in the console, not a calculated lot lifecycle state.

**1024 collapse:** implement a separate tablet `<details>` with a `<summary>` labelled Floor story, a 20px icon, state text, and **min-height:44px; min-width:44px; width:100%**. Default closed. Hide the desktop aside with `display:none`, removing its links from keyboard/accessibility navigation. The tablet disclosure is in normal flow, not sticky and not modal; opening pushes the work down and cannot cover it. Summary stays 44px high unless text zoom requires growth. Open content is full 992px width with 16px padding, then five stage cards in `repeat(5,minmax(0,1fr))`, 12px gaps. Inner width is 960px; each card is 182.4px wide before its own padding. Local anchors wrap in a second row of 44px targets; location is a full-width inset. Use an inset decorative outline so this arithmetic is unchanged. No width animation or auto-closing on selection; the summary provides native keyboard open/close state. Use unique IDs for duplicate desktop/tablet anchors. At actual viewports below 900px/text zoom, the open stage grid becomes one column and top bar rows wrap in normal flow; do not squeeze text or reduce hit areas. Native-size specimen width remains a review-sheet concern, not the production breakpoint strategy.

### Screen placement and dimensions

**Dashboard:** heading margin-bottom 20px. Three stat tiles in equal columns with 16px gaps (352px each desktop; 320px each tablet), minimum height 132px. Label 15px, count 40px/48px, definition 13px/20px. Main work begins 24px below desktop stats / 16px below tablet stats. Closing section has 16px inset and a 48px-min heading region, table header 44px, three 88px-min rows. At desktop its 720px inner table columns are **272 / 100 / 56 / 148 / 144px**. At tablet table inner width 960px; columns **400 / 130 / 80 / 190 / 160px**. Use inset borders, not additional width. Row height grows for long codes. Exception panel is 312px wide desktop with 20px padding and three 64px-min linked entries. Use exceptions first, closing table second in the shared DOM. At desktop assign exceptions to grid-column:2/grid-row:1 and closing to grid-column:1/grid-row:1. At tablet use normal one-column DOM order: exceptions become three equal tiles across 992px with 16px gaps and minimum height 88px, followed by the closing table. Keyboard order therefore remains exceptions then closing at both widths. Finance follows after 24/16px and uses three equal tiles; all three currency values remain visible. No synthetic total.

**Lot detail:** identity uses 24px padding, minimum height 188px, band gradient; left identity `minmax(0,1fr)`, right Photos/Edit buttons `auto`, gap 24px. Sticker 40px/48px at both widths; BIN 13px/20px; item title 18px/26px; metadata wraps with 8px/12px gaps. No 36px tablet downgrade. Font review card follows at 16px with 20px padding; it is clearly review tooling, not a lot operation. Evidence section at desktop is 640px outer with 20px padding, giving 600px; photo **200px** wide and 220px minimum height, gap 20, facts **380px**. Ownership follows at 16px within that column. Right decisions 424px with 20px padding and 12px between disclosures. At 1024 the evidence card’s 952px inner width is **280px photo + 24px gap + 648px facts**; decisions follow ownership after 16px. Facts use two equal columns, 16px gap; long location fields span both. Decisions never overlay evidence, and are not sticky. Notes, bid table and trail each span 1088/992px, with 24/16px gaps. Conditional action fixtures and state gallery are last, outside the main record narrative. All fields and actions from section 4 remain present.

**Pickups:** search comes directly after heading, before any queue. Field width `min(100%,560px)`; action beside it with 8px gap; help below. Pickup-pass strip follows with 12px gap, min-height 64px. Missing queue follows with 12px gap; its single row is never collapsed by default. At the counter starts 20px below, with two rows at least **180px** high and 12px gap. This height is a minimum: code wrapping or expanded confirmations grow it. The other queues follow with 24px gaps; each header is 44px minimum. Today one row; Waiting two; Recently done two, per G-COPY. No opacity applied to Recently done; use secondary ink and omit action controls. A section count always means loaded rows, not total customers or total remaining boxes.

Counter row desktop: 1088px outer, 16px padding, **1056px inner width**. Grid is **224px identity / minmax(0,1fr) owed / 216px actions**, two 16px gaps, yielding **584px owed**. Tablet: 992px outer, same padding, **200 / 512 / 216px**, two 16px gaps, totaling 960px inner. Use inset row border to preserve widths. Action column contains a full-width Mark complete (44px) and a second line of No-show/Forfeit (100px each, 8px gap); text may wrap within the 216px column only for explanatory copy. Identity contains customer 16px bold, invoice 15px underlined link within a 44px hit area, then payment chip and 13px schedule/warehouse lines. Owed column has a 13px heading then vertically stacked lot identities, 8px gaps; each sticker 24px/29px and BIN 13px/20px. No truncation, no “+N” collapsed remainder. Primary BIN replaces sticker where absent and carries a visible no sticker chip. Invoice link and code links are independent targets; the row itself is not an omnibus link.

## 4. Components and states

### Shared state rules

Every interactive control has default, hover, focus-visible, active/pressed and disabled or unavailable treatment where meaningful. Checked/current/open/busy/error states are additional states, never substitutes for keyboard focus. Noninteractive chips and skeleton bars are not tab stops. Minimum actionable target is **44×44 CSS px**, including text links, inline close controls, radio/checkbox labels and summary elements. Small 20px control marks live inside padded labels. Underline text links, except pill navigation; show selected navigation via rule + weight + current-page semantics. Disabled controls use full-opacity secondary ink and adjacent reason. Do not disable a whole row because one action is unavailable.

Where this spec says “brighter backing,” use `--g-gradient-active` exactly. Neutral controls/cards/rows use card fill at rest, active gradient on hover/focus-within, and retain that fill while pressed with an immediate 2px inset edge stroke. Primary/danger controls retain their own measured fill instead. Disabled/busy controls use card fill, secondary ink and edge border; do not lower opacity. Error inset always uses danger-bg/danger. Open disclosures keep card fill; their summary uses active gradient and a minus sign. Default checked radio/checkbox marks use ink on page fill; selected labels get active gradient plus the lime rule, never a lime text wash.

Focus: `outline:3px solid #F8F3FF; outline-offset:3px`; on lime controls add a stationary `box-shadow:0 0 0 2px #171221` separator so the light outline has a dark surrounding surface. Preserve the lime glow behind that separator. Focus within a moving card/row immediately cancels its entry animation and returns it to its final position. Cursor does not replace a visible label. Icons: inline 20px SVG, 1.75px stroke, round caps, `currentColor`, decorative icons `aria-hidden=true`; no icon font dependency.

**Pressed coverage:** links, pill buttons, nav links, summaries, radio labels, checkbox labels, invoice/code links use the press transform in section 6. Text input/select/textarea use an inset pseudo-outline opacity change, not a moving caret. Parent field wrappers can use `:has(input:active,select:active,textarea:active)`; native select/radio interaction remains intact. Disabled elements have no hover lift, glow change or press feedback. Hover effects run only under `(hover:hover) and (pointer:fine)`; keyboard focus gets the matching surface/ring, never a persistent displacement.

### Top bar / lookup

Input/button group is flex, gap 8, input `flex:1 1 auto; min-width:0`. **Find lot: `min-width:112px; flex:0 0 auto; white-space:nowrap; min-height:44px; padding:10px 20px; font:700 15px/20px var(--g-body)`**. Font comparison must not override that body role. Do not give both input and button `width:100%`. If the widest pairing needs more than 112px, intrinsic width wins and the input shrinks, never the text.

Ready input has page fill and edge border. Hover edge becomes ink; focus gets shared ring. Invalid specimen has danger inset/message and `aria-invalid=true`; empty and no-match are different. Busy specimen preserves entered text, shows Finding… and prevents repeat action with native disabled button; no spinner is necessary. Unavailable specimen preserves text and offers the ready-sample retry control. Loaded specimen links directly to corresponding detail frame.

**CSS-only boundary:** the normal mock Find lot is a styled anchor to `#g-l1440` / `#g-l1024`, labelled by the visible button text with the sample hint attached through `aria-describedby`. It always opens the fixed fixture; it does not pretend to resolve typed content. The text input remains editable but is not in a submitting form. Show the specimen hint directly below the lookup in a reserved in-flow strip beneath the top bar; do not squeeze it into the 96px bar. A state-gallery set of native radios explicitly previews ready/loading/no-match/error. In the future real console it is a submit button in the existing GET lookup form; Enter/scanner behavior and normalization stay unchanged. CSS cannot implement actual search, keyboard shortcuts or trim/case-insensitive identifier validation. Do not add JS to disguise that limitation.

### Split pane and floor steps

Desktop visible; tablet collapsed/open as section 3. Each stage: two-digit 13px number, 18px/24px display heading, one line or wrapping 13px/20px secondary explanation, one 44px link. Default uses card fill. Current uses active gradient, 3px lime inset rule, bold title and “Current section” accessible text; do not imply completed/blocked status. Hover lifts only the backing/card 2px; focused link cancels travel; pressed link 1px down. Current/open/hover are distinguishable without colour. Error/unavailable navigation specimen leaves label and explanation visible and omits the dead anchor; no fabricated queue count. Tablet summary’s plus/minus or chevron is supplementary to native expanded state.

### Stat tile and number tick-up

Three zones: label, fixed-height count window, definition. Labels/definitions never move. Count window uses `font-variant-numeric:tabular-nums lining-nums; line-height:48px; height:48px; overflow:hidden`; digit track contains four preformatted values on four 48px lines. Track is `aria-hidden=true`; a visually hidden static final value supplies the accessible text. No `aria-live` counter. Base (no-animation) transform is `translateY(-75%)`, showing the last of four lines. Animate the track only from `translateY(0)` to `translateY(-75%)`; no JS integer counter or unformatted CSS currency counter.

Exact tracks: Live **0 → 42 → 86 → 128**; Scheduled **0 → 2 → 4 → 6**; Today **0 → 6 → 12 → 18**; collected **$0 → $4,000 → $8,000 → $12,840**; revenue **$0 → $4,000 → $8,000 → $11,860**; fees **$0 → $200 → $400 → $642**. These are animation specimens, not historical observations. Money track text is 32px/48px; other count text is 40px/48px. Hover lifts tile 2px, focused child cancels lift; nonlinked tile has no button role or fake pressed action. Loading replaces count with skeleton plus Loading sample rows, not 0. Empty/missing metric is em dash plus Unavailable, never a measured zero. Error has explicit text and retry specimen. A legitimate zero must display literal 0.

**Money format:** every currency string, including loading-final values, search result, confirmation and gallery example, has US grouping: **$12,840**, never `$12840` or a separated dollar sign with ungrouped digits. Whole-dollar samples omit `.00`; genuine cents, if shown in a state example, use **$1,284.50**. Never round away nonzero cents. Currency and amount are one unbroken text unit (`white-space:nowrap`). This is a rendering rule, not a change to stored cents or financial definitions.

### Dense table row

Native table with caption, `th scope=col`, `table-layout:fixed; border-collapse:separate; border-spacing:0`; column widths in section 3. Body 15px/22px; header 13px/18px; primary sticker 24px/29px bold; secondary BIN 13px/20px; code cell first, right-align money and bid counts. Minimum row 88px for two-line identity; ordinary bid rows 64px. Wrap code with `overflow-wrap:anywhere`; never ellipsize or make BIN brighter/larger. Borders inset; 8px horizontal cell padding is included in column widths.

Hover row has brighter backing and `translateY(-1px)` on the row visual wrapper; pressed via `:has(a:active,button:active)` uses `translateY(1px)` without shrinking text. For browsers where transforms on `tr` paint incorrectly, apply the same transform to each cell’s `.g-cell-inner`, preserving native table semantics and identical backgrounds; do not change `<tr>` to a block. Entry motion runs on a separate inner layer so hover does not overwrite it. Focus-within has bright backing and a ring on the link, no row transform. No row selection is invented. Empty uses a full-span explanatory cell; loading uses three fixed-height skeleton rows; error full-span text and retry. Unavailable lot identity displays Identifier unavailable and retains whatever BIN is actually supplied; no fabricated code.

### Lot identity and decisions

Sticker is the largest identity text, **40px** at both widths; product name never competes. Use `lotDisplayCode` semantics as a data contract: server display label, physical/inherited sticker, then canonical lot code. Do not label an inherited sticker as missing because the current row’s sticker field is null. If primary equals canonical BIN, show it once at 40px and attach no sticker; never duplicate it in the secondary line. Long test fixture **BRN4982227-LONG-SAMPLE-0001** wraps naturally without shrink-to-fit. Missing all identifiers shows Identifier unavailable. Historical/successor notices appear immediately under identity, above decisions, and link explicitly to the current record; they never redirect silently.

Main unsold fixture: no bids, no successor, sample admin/manager. Photos/Edit visible; Delete shows the physical-footprint refusal; Relot / Relist opens by default; Remove from inventory and Keep for business closed by default. Delete eligibility comes before Relist. Keep action panels inline, native `<details>`, 44px summary; entry animates only the child content. No nested modal or overflow menu. Keep fields/notes when a disclosure closes; CSS-only Back to options is a local anchor, not a claimed reset operation.

Relist retains the target-auction select, both sample choices, no-target state and no enabled submit in that state. Removal retains all six exact outcome values (`destroyed`, `bin_store`, `donated`, `liquidated`, `missing`, `other`), none preselected, optional textarea maxlength 400, the sticker/BIN header, permanent-record warning, and a typed-code field shown only by `:has(input[value="destroyed"]:checked)`. Keep retains blank price, min 0 / max 1000000 / step 0.01, reason textarea maxlength 500, explicit zero rule, and not-a-sale explanation. Existing bid/invoice/successor/removal/role checks are not redefined.

In this CSS specimen, operative destructive submission buttons stay disabled and their reasons stay readable. A separately labelled Preview result disclosure shows a **pre-authored sample result**, not validation of typed fields. In the real product the existing validated submit buttons stay operable under their current guards; the disabled mock controls are not a proposed extra production gate. Include separate eligible Cancel (`BIN-031090`) and Delete (`BIN-031091`) examples, with visible confirmation previews. Never enable Delete on the main stickered fixture. Show idle, busy, refusal/error and sample-success as explicit gallery radio scenarios; selectors cannot enforce a real server decision.

### Chips

28px minimum visual height, `padding:4px 10px`, body 13px/18px weight 700, gap6, no forced uppercase. Required eight states always visible in the lot reference gallery. Noninteractive chips need not be 44px. Linked chips, if any, have a separate 44px outer hit area. Long labels wrap at narrow/zoomed sizes; no clipping. Hover does not turn paid into handed over, sold into paid, or change a real row’s status. Live → Sold morph lives in a clearly labelled motion specimen with native checkbox trigger and keyboard label; dimensions reserve the larger label. Accessible operational state remains unchanged.

### Pill buttons

Primary: lime gradient/on-lime ink, no translucent label, 44px minimum, 20px horizontal inset, weight 700 body 15px, glow. Secondary: card fill/ink with edge border. Danger: danger fill/danger ink and 1px danger boundary; same dimensions. Rest/hover/focus/press preserve text pair; move/raise only decorative layer or outer control. Checked/current uses active violet gradient plus rule; no second lime fill for ordinary navigation. Busy uses a fixed-width label and disabled state, never a shrinking control; disabled secondary/card/secondary ink removes glow but remains legible. Error explanation remains under the affected action. Where a native disclosure mimics a button, keep `<summary>` semantics instead of assigning an inaccurate role.

### Counter row and pickup behavior

Geometry and fixture contents are in section 3/G-COPY. Customer, short invoice link and every owed identity are simultaneously visible. Invoice label must be **Invoice #4372a705 ↗** style, with the first eight characters of the supplied fake ID. In the mock it is an ordinary link to `#g-p1440-invoice-4372a705` (or corresponding1024 target); in the application it represents `/invoices/[full-id]`, never a route made from just the shortened label. Arrow means leave pickup context, not “new tab”; do not open another tab. Each local invoice target has a heading, sample notice, same customer/ID and a Back to pickup row link. It is an appendix destination, not a seventh screen frame.

Default checked-in rows expose **Mark complete**, **No-show**, **Forfeit** directly; no overflow menu or new mandatory confirmation on the ordinary complete/no-show production paths. In the mock these are native summary triggers for explanatory result previews. Mark complete available only for paid or partially_refunded invoice specimens; unpaid/unknown invoice specimen keeps a disabled control plus a visible invoice link and reason. Fully refunded gets only Close pickup (refunded). Completed/no_show/forfeited terminal specimens have no mutation actions. Current Recently done query includes completed/no_show, not forfeited; show forfeited only in the component gallery.

Partially handed-over row keeps checked-in status and the remaining owed codes; collected/refunded items must not reappear as owed. The supplied PR description does not establish the precise predicate; label the fixture result explicitly rather than designing a replacement query. If lot loading fails, show the error in place of the lot list and direct staff to the invoice. No-sticker chip is per lot, not per customer. Missing customer shows Customer name unavailable; invoice remains independently visible. Missing invoice target has no fake link. Paid and pickup-state chips remain separate.

Hover/press uses the same restrained 2px/1px card treatment; focus cancels travel. Busy specimen preserves customer, invoice, codes and pending label, disables repeated actions. Failure preserves row in its original queue with error and retry; success preview does not move a real row or assert handover. Empty section keeps its heading, count 0 and specific G-COPY text. Loading maintains row geometry and readable status text. Search is editable and immediately reachable; fixed result disclosure, minimum-character/empty/error/loading review scenarios are explicit. Do not implement fake CSS substring search. The real existing search waits 400ms after two trimmed characters; preserving that contract does not authorize changes here.

Pickup-pass checkbox toggles only sample On/Off copy. Missing refund queue stays before counter, with sticker, fake customer, invoice link, marked time and both actions; Mark resolved preview explicitly does not issue a refund. Keep no-show/forfeit consequences and the real completion payment guard intact.

### Skeleton and toast

Skeleton base is section fill within a card, with 12px radius, 12px-high bars at 100%,72%,48% width and 12px gaps. A fixed gradient pseudo-element `linear-gradient(100deg,transparent,#3C2D52,transparent)` translates horizontally; no animated background-position. Skeleton blocks `aria-hidden=true`; adjacent text announces Loading sample rows. Only the labelled loading specimen loops. Never use shimmer as an indefinite substitute for an error; reduced motion leaves solid bars.

Toast is a glass inset at the right of the component gallery, **width:min(360px,100%)**, radius16, padding16, minimum80px. Position it in a reserved gallery slot; it may float visually with shadow, but it is not viewport-fixed and cannot cover lookup or pickup controls. A native Show sample notice checkbox above the slot toggles it with `:has()`; its associated 44px Hide sample notice label unchecks the same control. No auto-dismiss timer, close icon without label, or JS toast manager. Hidden toast uses `display:none`, not merely opacity 0. Its static sample text need not pretend that CSS reliably triggers live-region announcements; a real asynchronous toast would use `role=status`/polite and still retain inline errors. Gallery has default(hidden), shown, and error-styled notice examples; the latter uses danger inset and exact failure copy, no extra automatic motion.

## 5. Exactly three Google Fonts pairings

Use novelty **display** type for headings, stage titles, brand and metric numbers. Operational sticker/BIN codes deliberately use the selected pairing’s **body** family at 700: 40px for identity and 24px for rows; dense table prose 15px/22px at 400, labels 700. This keeps the display’s unusual proportions out of lookalike code sequences while the entire mockup still changes family with the selected pairing. Do not introduce a fourth mono family, Space Grotesk, Outfit or Inter. No faux weight/italic: `font-synthesis:none`.

**Character-check evidence:** family availability, weight ranges and SIL OFL 1.1 licences were checked in the official Google Fonts repository on 2026-10-09. Browser access to the Google Fonts visual specimen was denied, so **rendered 0/O,1/I/l,5/S,8/B separation at 40px/15px is not verified**. The assessments below are design rationale and explicit acceptance targets, not a claimed visual pass. Include the exact proof strip from G-COPY in each lot view. Before accepting a pairing, the implementer must visually compare every listed group in the loaded body font at both sizes, including the zero feature; do not assume an unsupported OpenType feature exists.

### 1 — Syne + Atkinson Hyperlegible (default)

- Display **Syne 600, 700**; body/code **Atkinson Hyperlegible 400, 700**. Syne gives wide, offbeat headline shapes; use 600 for headings/metrics and 700 only for the brand/stage title. Atkinson provides the quiet, explicitly differentiated reading layer.
- Code rationale: the body’s differentiated zero, barred capital I, shaped lowercase l and numeral 1 are intended to separate **0/O** and **1/I/l**; angular 5 vs curvedS and numeral 8 vs stemmedB address **5/S,8/B**. At 40px/700 BRN4982227 remains a practical label; at 15px/400 the same body handles names and short IDs. All four groups require the rendered check above; no claim that Syne’s display glyphs passed the code test.
- Licence: both **SIL Open Font License 1.1**. Official [Syne licence](https://github.com/google/fonts/blob/main/ofl/syne/OFL.txt) and [Atkinson Hyperlegible licence](https://github.com/google/fonts/blob/main/ofl/atkinsonhyperlegible/OFL.txt); [Syne metadata](https://github.com/google/fonts/blob/main/ofl/syne/METADATA.pb), [Atkinson metadata](https://github.com/google/fonts/blob/main/ofl/atkinsonhyperlegible/METADATA.pb).
- Exact stylesheet URL: `https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Syne:wght@600;700&display=swap`

### 2 — Unbounded + IBM Plex Sans

- Display **Unbounded 600, 700**; body/code **IBM Plex Sans 400, 700**. Unbounded’s extended, squared shapes make the section bands distinctive; do not condense it or apply negative letter spacing to fit. Plex supplies open, compact working text.
- Code rationale: compare **0/O** with `font-variant-numeric:slashed-zero` requested on codes, **1/I/l** through Plex’s separate numeral/capital/lowercase construction, **5/S** through flat top versus continuous curve, and **8/B** through numeral versus vertical letter stem. At 40px body 700 the full sticker is the identity; at 15px body 400 invoice IDs must still pass. Feature availability and all four rendered groups are pending; if the delivered font does not provide a distinguishable zero, mark pairing 2’s code test failed rather than inventing a slash in CSS.
- Licence: both **SIL Open Font License 1.1**. Official [Unbounded licence](https://github.com/google/fonts/blob/main/ofl/unbounded/OFL.txt) and [IBM Plex Sans licence](https://github.com/google/fonts/blob/main/ofl/ibmplexsans/OFL.txt); [Unbounded metadata](https://github.com/google/fonts/blob/main/ofl/unbounded/METADATA.pb), [Plex metadata](https://github.com/google/fonts/blob/main/ofl/ibmplexsans/METADATA.pb).
- Exact stylesheet URL: `https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;700&family=Unbounded:wght@600;700&display=swap`

### 3 — Anybody + Source Sans 3

- Display **Anybody 600, 700, width 100**; body/code **Source Sans 3 400, 700**. Anybody has a poster-like, buoyant voice without becoming a script or distressed face. Use its normal width, not a narrow novelty setting. Source Sans 3 carries dense operational lines.
- Code rationale: request slashed zero for **0/O**, inspect numeral 1 versus capitalI and lowercase l for **1/I/l**, and compare **5/S** and **8/B** by top bar/curve and numeral/letter stem. Body700 at 40px provides the large code; body 400 at 15px keeps table rhythm. Source Sans 3’s humanist construction is the legibility rationale; all four rendered groups and feature delivery remain pending. If any pair needs context to tell apart, record that as a failure, not an owner-preference tie.
- Licence: both **SIL Open Font License 1.1**. Official [Anybody licence](https://github.com/google/fonts/blob/main/ofl/anybody/OFL.txt) and [Source Sans 3 licence](https://github.com/google/fonts/blob/main/ofl/sourcesans3/OFL.txt); [Anybody metadata](https://github.com/google/fonts/blob/main/ofl/anybody/METADATA.pb), [Source Sans 3 metadata](https://github.com/google/fonts/blob/main/ofl/sourcesans3/METADATA.pb).
- Exact stylesheet URL: `https://fonts.googleapis.com/css2?family=Anybody:wdth,wght@100,600;100,700&family=Source+Sans+3:wght@400;700&display=swap`

### Whole-sheet CSS switcher

Load all three stylesheet URLs in the review mock; escape ampersands as `&amp;` in HTML attributes. Google Fonts is the only remote dependency. `display=swap` required. If blocked/offline, fall back to `Arial,sans-serif`, retain all dimensions/labels and visibly note the fallback during review; that is not approval of the intended fonts.

There is **one canonical native radio fieldset** on the 1440 lot page, immediately after identity: `name="g-font"`, IDs `g-font-1/2/3`, values 1/2/3, pairing 1 checked. All labels 44px high, full family names. Tablet lot page has its proof strip and a 44px Compare typefaces link to that fieldset. Do not make two unsynchronized fieldsets that compete via `:has()`. The choice is global and persists only while the static document is open. The 1024 review link navigates within the review sheet, not the product. No JS or storage.

```css
body { --g-display:"Syne",Arial,sans-serif; --g-body:"Atkinson Hyperlegible",Arial,sans-serif; }
body:has(#g-font-1:checked) { --g-display:"Syne",Arial,sans-serif; --g-body:"Atkinson Hyperlegible",Arial,sans-serif; }
body:has(#g-font-2:checked) { --g-display:"Unbounded",Arial,sans-serif; --g-body:"IBM Plex Sans",Arial,sans-serif; }
body:has(#g-font-3:checked) { --g-display:"Anybody",Arial,sans-serif; --g-body:"Source Sans 3",Arial,sans-serif; }
body { font-family:var(--g-body); }
.g-frame h1,.g-frame h2,.g-frame h3,.g-brand,.g-number { font-family:var(--g-display); }
.g-frame .g-code,.g-frame .g-bin { font-family:var(--g-body); font-variant-numeric:tabular-nums lining-nums slashed-zero; }
button,input,select,textarea,summary { font-family:var(--g-body); }
```

Every frame, review label, button, input, table, pane and toast inherits these variables; no hard-coded per-frame type overrides. Proof strings include one 40px/700 line and one 15px/400 line in the selected body family, plus the section heading in the selected display family. Plain body text 15px/22px; page headings 32px/40px desktop and28px/36px tablet; section headings 22px/28px; floor headings 18px/24px; metadata 13px/20px; badge 12px/18px. Long headings wrap, never reduce code size to accommodate a wide display face.

## 6. Motion and reduced motion

More layered than D/E/F, without a longer path to the task. Inputs and actions are present and usable from first paint; never delay pointer-events, focusability, a result or server feedback until an animation completes. Entry has no opacity 0 content hold. Initial content opacity is at least 0.96; decorative backings may fade from0. No infinite glow pulse. On touch there is no hover movement. No `transition:all`, layout-property animation, animated blur or permanent `will-change` on an entire list.

Use separate layers for entry and interaction transforms. Motion does not change layout dimensions. Remove finished entry transforms (`animation-fill-mode:backwards`, with ordinary base style at final transform) so they do not leave containing blocks around sticky elements. Reload replays entry; a native details reopen replays its child reveal. Font switching is an immediate reflow with **no** font-size/width/colour transition.

| Motion | Trigger | Duration / delay | Exact easing | Animated property / values |
| --- | --- | --- | --- | --- |
| Frame entry | Document/frame load, all six frames | 280ms /0 | `cubic-bezier(.16,1,.3,1)` | Frame decorative surface `opacity:0→1`; content wrapper `transform:translateY(8px)→none`, `opacity:.96→1`; exclude sticky top bar |
| Left pane slide | Load; tablet floor details opens | 360ms /0 | `cubic-bezier(.16,1,.3,1)` | Inner floor content `transform:translateX(-16px)→none`, `opacity:.96→1` |
| Right pane slide | Load | 360ms /0 | `cubic-bezier(.16,1,.3,1)` | Right content inner `transform:translateX(16px)→none`, `opacity:.96→1`; lookup stays stationary |
| List stagger | Load, first five rows per visible list | 280ms / `min(index,4) ×45ms` | `cubic-bezier(.2,.8,.2,1)` | Separate row-entry inner `transform:translateY(8px)→none`, `opacity:.96→1`; zero-based index; max 180ms delay; later rows immediate |
| Inline panel reveal | Native details open | 240ms /0 | `cubic-bezier(.16,1,.3,1)` | Child `transform:translateY(6px)→none`, `opacity:.96→1`; height opens immediately; closing is immediate |
| Live → Sold chip | Dedicated sample checkbox checked; uncheck reverses | 240ms /0 | `cubic-bezier(.2,.8,.2,1)` | Two complete opaque chip layers: outgoing label `translateY(0)→translateY(-6px)`, `opacity:1→0`; incoming `translateY(6px)→none`, `opacity:0→1`; no background-colour tween |
| Number tick-up | First frame load | 1100ms /0 | `cubic-bezier(.16,1,.3,1)` | Preformatted track `transform:translateY(0)→translateY(-75%)`; final accessible value static; never text-content mutation |
| Card hover | Fine pointer hover on actionable card/stat surface | 160ms /0 | `cubic-bezier(.2,.8,.2,1)` | Visual wrapper `transform:none→translateY(-2px)`; fixed shadow pseudo `opacity:0→1` |
| Table-row hover | Fine pointer row hover | 160ms /0 | `cubic-bezier(.2,.8,.2,1)` | Row visual wrapper/cell inners `transform:none→translateY(-1px)`; fixed backing pseudo `opacity:0→1` |
| Pressed controls | Pointer/key active on every actionable control | 120ms /0 | `cubic-bezier(.3,0,.7,1)` | Pill/summary/link/label `transform:translateY(1px) scale(.99)`; row translation 1px only; release returns to applicable hover/base transform |
| Pressed editable field | Native input/select/textarea active | 120ms /0 | `cubic-bezier(.3,0,.7,1)` | Inset stroke pseudo `opacity:0→1`; caret and text do not move |
| Accent hover glow | Primary control hover/focus | 160ms /0 | `cubic-bezier(.2,.8,.2,1)` | Prepainted glow pseudo `opacity:.65→1`; box-shadow values remain fixed |
| Skeleton shimmer | Labelled loading example only | 1600ms /0, repeating | `cubic-bezier(.4,0,.6,1)` | Pseudo `transform:translateX(-100%)→translateX(100%)`; no background-position or width changes |
| Toast enter | Show sample notice checked | 240ms /0 | `cubic-bezier(.16,1,.3,1)` | Shown toast inner `transform:translateY(8px)→none`, `opacity:.96→1`; hide immediate |

Do not morph any row’s operational status on hover. The chip demonstration’s accessible name says it is a motion sample; underlying lot state stays Live. The two full chip layers preserve their own measured foreground/background pairs; do not crossfade unbacked text over a third colour. Native details/checkbox/radio semantics remain correct while CSS changes presentation.

### Reduced-motion outcomes (both mechanisms are mandatory)

One visible global checkbox **Preview reduced motion**, ID `g-reduce`. The selector `body:has(#g-reduce:checked)` and `@media(prefers-reduced-motion:reduce)` independently apply the same outcomes. Unchecking cannot override the OS preference. Keep the checkbox in the review header, with 44px target. It is not a production user setting.

| Normal effect | Reduced outcome |
| --- | --- |
| Frame entry | Final layout immediately; content opacity 1; no translation |
| Left/right slide | Pane appears at final position immediately; toggle still opens/closes |
| Row stagger | Every row visible immediately, no delays |
| Disclosure reveal | Native open/close immediately, content fully visible |
| Chip morph | Always show Live layer; hide Sold layer even if sample checkbox checked; keep explanation visible |
| Number tick-up | Hide animated track; show a separate preformatted final visual value; static accessible value unchanged |
| Card/table hover | No lift; immediate brighter backing/edge remains |
| Pressed controls | No scale/translation; immediate inset stroke remains as pressed feedback |
| Pressed fields | Inset stroke changes immediately, no fade |
| Glow | Fixed normal shadow; no glow opacity transition or pulse |
| Skeleton | Solid bars; hide shimmer pseudo-element |
| Toast | Show/hide immediately; no displacement or fade |
| Anchor navigation/font switch | Immediate jump/reflow; no smooth scroll or animated typography |

Implementation pattern: cancel animations/transitions on descendants and pseudo-elements in both selectors; explicitly restore final visuals per component. Do **not** blanket `opacity:1!important` every layer: that would expose the hidden Sold layer, toast and shimmer. Normal base styles already contain final layout; reduced override must set `.g-entry` opacity 1/transform none, `.g-motion-sold{display:none}`, `.g-shimmer::after{display:none}`, `.g-number-track{display:none}`, `.g-number-final{display:block}` and remove hover/press transforms. Hidden state panels remain `display:none`; the checked/unchecked visibility rules still apply. Accessibility text must not duplicate when the static number becomes visible: both animated track and static visual are aria-hidden, with a single final accessible value.

## 7. Build checklist and acceptance

### Deliverable and structure

- [ ] Implement only the later-authorized HTML file `docs/design/console-v2/directions/g-nightshift.html`; this handoff itself is just G-SPEC/G-COPY.
- [ ] One self-contained HTML document, inline CSS/SVG, **no JS**, no runtime/library install, no real API, form submission, storage, telemetry, live mutation or real customer data. Google Fonts stylesheets are the only external resource exception.
- [ ] Six frame IDs/order/sizes exactly as section 3. Every frame visibly says Sample data. Use complete fictional names Test Customer A–H and only G-COPY’s fake IDs/codes.
- [ ] Single global font radio group on the lot page; pairing 1 default; variables change all six frames. Single global reduced-motion checkbox plus independent OS preference.
- [ ] Global review anchors link to all six frames. In-frame Dashboard/Lot detail/Pickups and Find lot link to the matching-width specimen. No dead `href="#"`. Floor actions outside these screens link to labelled local destination notes in that frame’s gallery. Lot/queue section links target actual sections. Invoice links navigate out of pickup rows to local invoice appendix targets and back.
- [ ] Duplicate fixture/state controls use frame-prefixed IDs and radio names. Only font and motion controls are global. `<details>` open/closed, input checked/unchecked and `:has()` are the interaction primitives; no hidden JavaScript dependency.

### Every CSS-only interaction to demonstrate

1. Navigate among all six frames; Find lot opens the sample lot instantly and explains the fixed fixture. Editable lookup is labelled; ready/loading/no-match/error radios switch sample states without pretending to search.
2. Expand/collapse Floor story at 1024 with mouse, touch and keyboard; all five stages and local anchors remain accessible. Desktop floor stays visible.
3. Switch each of the three font radios; compare both-size proof strips and all headings, values, tables, inputs and buttons. No locally stuck font family. Font failures are reported, not silently called a successful comparison.
4. Hover cards and table rows; press every control family; tab through visible rings. Focus on a moving target immediately settles it. Touch gets pressed feedback without sticky hover.
5. Toggle the dedicated Live → Sold specimen; never alter an operational row. Reload shows frame entry, pane slide, list stagger and number tracks; skeleton loops only in its labelled specimen.
6. Toggle Preview reduced motion while animations are running; verify final formatted numbers, static Live chip, static skeleton, instant reveals, no travel. Repeat with OS reduce while checkbox unchecked.
7. Open Photos/Edit destination previews; open/close Relist/Remove/Keep/Delete eligibility. Select each removal outcome; only Destroyed reveals typed-code field. Fields accept input; results remain explicitly pre-authored previews. No CSS validation is presented as protection.
8. Counter invoice links and every owed code are individually reachable. Mark complete/No-show/Forfeit open sample explanation/confirmation; unpaid state has completion disabled; fully-refunded state has only close. Partial-hand-over fixture continues to show its remaining lot list.
9. Customer search field accepts text; Show sample result exposes fixed Test Customer A invoice. Review radios expose minimum-input/loading/empty/error states. Radio-driven fixtures are visibly review controls, not production search controls.
10. Toggle sample pickup pass On/Off; inspect missing-refund action previews; show/hide the sample toast via its native checkbox/label. No external settings or records change.
11. State gallery includes all eight chips; no-sticker/inherited/long-code/unavailable identities; stat zero/unknown; row empty/loading/error; button disabled/busy/error; absent customer/invoice/owed-data error; and each queue’s specific empty copy. Gallery controls reveal these on demand, keeping normal screens focused.

### Acceptance checks before the HTML is handed back

- [ ] At 1440 and 1024, all three fonts: measured frame `scrollWidth` does not exceed its specified width; codes wrap; no horizontal scrollbar inside a frame; input+Find lot fit with a single-line button. Inspect longest radio labels and wide display headings.
- [ ] Sticker is40px detail/24px rows, secondary BIN 13px and visibly dimmer but AA. No sticker fallback is explicit; inherited physical labels do not become no sticker. Compare BRN4982227, BIN-031005 and all four lookalike groups at 40px/700 and15px/400 for each pairing. Record pass/fail; current spec does not claim rendered passes.
- [ ] Body≥4.5:1, secondary≥4.5:1, text-on-lime≥4.5:1, glass fallback/enhanced worst case≥4.5:1; edges/focus≥3:1. Verify all gradient endpoints, status pairs, placeholders, disabled text, errors and selected states. Force backdrop-filter unsupported and confirm the opaque fallback is present.
- [ ] Every interactive target ≥44×44px; code/invoice links not nested in a clickable row; input labelled; native radio arrows, Space for checkbox/summary and Tab work; hidden states are neither tabbable nor exposed as duplicate active content.
- [ ] Monetary text always grouped. Check final **$12,840**, **$11,860**, **$642**, search **$1,284** and any cents fixture. No animated count state drops commas, and reduced motion never shows0 in place of a loaded final value.
- [ ] No task waits for animation, skeleton or drawer. Lookup is reachable immediately; customer search appears before queues; all counter actions/codes stay visible; exceptions are exposed without a disclosure. This is a design constraint, **not a measured claim that G is faster**. Later compare real lookup, physical checkout and exception tasks with today’s console before rollout.
- [ ] Reduced motion passes all outcomes in section 6, including checkbox toggled mid-count, OS reduce with checkbox off, hidden Sold layer, paused shimmer and still-usable disclosures. No `transition:all` or animated filter/layout dimensions.
- [ ] Counter/Today/Waiting/Recently done are all present. Payment eligibility, fully-refunded close, partial owed lots and missing-refund workflow remain distinct. No currently checked-in customer is hidden because an appointment is absent. Loaded caps are not called total inventory/customer counts.
- [ ] Six screens contain fresh G headings/subtitles/empty states from G-COPY. None reuses the three rejected D/E/F headline phrases. Required established product/action labels may repeat.
- [ ] Check font-load failure, long code, expanded disclosures, both notices and 200% text zoom. No clipped actions, lost focus, false current state or sticky layer obscures an anchor target. Inspect a real 1024 landscape device later for glare and scanning; static docs are not that test.
- [ ] Record HTML validation/rendering/keyboard checks with their actual outcomes; distinguish not-run from pass. No production integration, deployment, authorization test, install or commit is implied by this handoff.

### Remaining uncertainties

1. **Rendered font ambiguity and fit:** browser specimen access was denied. Font families, weights and licences are verified; actual glyph separation, OpenType zero delivery and layout in the six frames still require rendered review. Pairing1 is the default proposal, not a pre-approved winner.
2. **PR #452 filtering:** only the owner’s description is available. The implementer must preserve its actual owed-lot logic when integrating later; this static fixture establishes presentation, not a query contract invented from invoice status.
3. **CSS-only scope:** real lookup/search, scanner Enter, asynchronous announcements, typed-code normalization, double-submit guards and record mutation require existing application behavior. This mock deliberately demonstrates their visual states without claiming to implement them.
4. **Task speed and devices:** no live comparison or warehouse-glare test was run. Geometry, direct actions and motion cancellation protect the design intent; operational parity remains a later acceptance measurement.
