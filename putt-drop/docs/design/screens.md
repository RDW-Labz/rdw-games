# Pocket Park screens and states

Status: implementation handoff, 2026-10-12. Covers every state in [brief section4](brief.md#4-screens-and-states-in-scope), plus the developer gallery. Uses [system tokens/components](system.md) and [motion effects](motion.md). Coordinates here are normative design recipes for `TOKENS.layout`; implementation is a later job.

## 1. Coordinate, safe-area and input contract

Separate **UI space** from **golf world space**. The baseline UI is360×640; the golf world remains360×640 regardless of phone dimensions. All rectangles below are `(left, top, width, height)` in UI logical px; text positions mean top-left unless called a center. Do not mix these with study coordinates or device pixels.

For viewport CSS size `VW,VH`, UI scale `s=VW/360`, logical width 360, height `H=VH/s`. Render the backdrop to the full viewport, without stretching circles or fonts. Query actual safe insets from the host/CSS `env(safe-area-inset-*)` and convert to logical units once: `T=ceil(top/s)`, `B=ceil(bottom/s)`, `L=ceil(left/s)`, `R=ceil(right/s)`. If native safe insets are unavailable, use fallback logical top 24/bottom 24, not zero. Respect provided zero on a device that truly has no inset. DPR controls texture/text resolution, never these coordinates. On viewport/inset changes recompute layout, cancel partial aim and settle decoration; keep gameplay state.

Content gutters `Gleft=max(16,L+8)`, `Gright=max(16,R+8)`, `CW=360-Gleft-Gright`. Center `CX=(Gleft+360-Gright)/2`. Fixture phones have Gleft=Gright=16, CW328, CX180. Define bottom content edge `A=H-B-16`, top-bar bottom `TB=T+64`, scroll-body top `Y=T+80`. Primary action center belongs below `T+2*(H-B-T)/3` wherever a conventional primary button exists. Gameplay's primary target is the ball/drag, not an unrelated bottom button; tees stay in their authored lower-third positions.

All actionable hit rectangles are at least56×56 logical (49.8px physical on the short fixture). Focus/shadow padding must not enlarge hit rectangles into neighbors. Layout may extend vertically on tall screens; do not scale a640px screenshot to fill932px height. For left/right insets, substitute `Gleft/CW/CX` for 16/328/180; two-column card width becomes `(CW-12)/2`.

### Required fixture numbers

These are explicit test insets, not promises about every device of that size. Test additional actual device insets using the formulas.

| Fixture | CSS size, scale | H; top/bottom CSS insets | Logical T / B / A | Top bar; body start | Menu primary top; single-footer primary top |
|---|---|---|---|---|---|
| Baseline |360×640,1 |640;24/24 |24 /24 /600 |y24–88;Y104 |444;544 |
| Short |320×568,0.888889 |639;20/0 |23 /0 /623 |y23–87;Y103 |467;567 |
| Tall |430×932,1.194444 |780.279;59/34 |50 /29 /735.279 |y50–114;Y130 |579.279;679.279 |

Fractional coordinates stay unrounded for layout/transforms; snap only baked pixel edges after multiplying by render scale. Sheets anchor their bottom atA, not at a hard-coded640. All scrolling bodies clip before the fixed footer with 12px clearance; never scroll controls behind an invisible active hit region. A short page scrolls instead of shrinking fonts or tap targets. No screen has horizontal scroll. Safe area itself is background only; do not draw a fake OS status bar/home indicator.

Reusable footer recipes: `singleFooter` primary `(16,A-56,328,56)`; `pairedFooter` primary at A-120 and secondary at A-56, each56 high; `offerFooter` primary at A-184, Restore at A-120, free replay at A-56. Gaps8. Primary may be first in a stack as long as its center is in the lower third. Footer labels can wrap to two24px lines inside56px; never shrink a long localized price. Accessible focus order follows reading order then actions.

## 2. Boot/loading

**Primary:** auto-advance to Menu as soon as bundled assets, fonts and local-save read resolve; no minimum logo hold. Components: baked mark, progress dots, error card only if needed. Motion: `bootResolve`; no ambient loading loop required.

Mark centered `(CX,T+(A-T)*0.42)`, size 96×96. Three8px dots below its lower edge by 24, centered; determinate asset stages only, not fake progress. Before fonts resolve use the mark without text. Once ready, “Opening the park…” uses caption centered below dots by 16. A cold first run and offline boot have identical visuals and no account/network gate.

Font failure: retain mark, use a **baked Fredoka/Nunito error texture** reading “Couldn’t load the park. Try again.” in a328×112 region centered at the same y; baked Retry pill atsingleFooter plus accessible Retry name. Builders generate this fallback from bundled fonts at build time. Retry reloads bundled resources, not a font CDN. Level load/parse failure uses normal fonts if available, same error card and Retry. Never render a blank screen or silently use system fonts. A save read/parse error goes to the recoverable state in section13; distinguish it from a genuinely empty save.

## 3. Menu: first run and progress

**Primary:** Play for first run; Continue for existing progress. Components: primary pill, secondary Holes pill, Settings icon, wordmark, decorative island, optional progress caption. Motions: `treeSway`, `cloudDrift`, `lightShift`, `titleBreathing`, `menuBallFloat`, `controlAppear`, `parkTravel`.

Settings icon `(288,T+8,56,56)`. Wordmark two lines in `(32,T+76,260,104)`, type.logo, slight fixed−4° tilt; text “Putt” then “Drop” with second-line x+32. Tagline “A tiny course. A happy place.” in `(32,T+184,296,22)`. Hero island centered at `(CX,(T+222+A-172)/2)` with maximum 300×160; available height `max(0,A-172-(T+222))`; uniformly fit art into that height without touching wordmark/actions. On baseline that height 182, short206, tall291.279, so maximum 160 fits all three. No unreadable captions in hero art.

Primary `(16,A-156,328,56)`; label Play or Continue. One line of factual status above at `(16,A-184,328,18)`: “Start with hole 1”, “Hole N · {name}”, or “All available holes finished”. Holes secondary `(16,A-88,328,56)`. Bottom caption `(16,A-20,328,18)`: “12 free holes · One unlock for the rest” only when paid content is actually offered; current12-hole-only bundle says “12 free holes · Play offline”.

`Continue` uses the existing `nextHole` availability/progress rules, never points at a locked or nonexistent hole, and never implies resuming an unsaved mid-stroke position. First run has no stars/progress percentage. Existing local best scores supply optional status, not fabricated “daily” content. If all available holes are finished, primary label **Play again**, routes to a valid available hole. A read/save problem adds the nonblocking honest banner/toast from section13; useful actions remain available with explicit session-only progress if chosen.

## 4. Hole select / full-game panel

**Primary:** Play hole N using the recommended available hole in the bottom primary pill. Tapping any available card is a direct shortcut to that same play action for that hole. Components: top bar with back, two-column hole cards, scroll viewport, full-game information card, lock badge, stars, primary footer. Motion: `cardAppear` only on initial visible cards, `buttonPress/Release`, `parkTravel`.

Top bar atT. Grid viewport `(16,Y,328,A-Y-76)`. Two columns atx16/186, widths158; row top `Y+row*164-scrollOffset`, H152, gap12. Clip at A-76; last row may be partly visible but its offscreen targets must not respond. Scroll starts after8px movement; cancel card tap when scrolling. Persist viewport position when returning from a hole or offer. No free holes are sequentially locked: holes 1–12 are available from first run.

Fixed primary `(16,A-56,328,56)` says **Play hole N**, with N from the same available-hole recommendation used on Menu. All grid cards retain secondary surface styling; no second coral action. Full-game information card follows the last grid row at `Y+rows*164-scrollOffset`, width 328/height 152. Its title atlocal(16,12) says “More park to explore”, body at (16,44),296×36 states the exact additional hole range and “One purchase”, and secondary **Full game** at (16,88,296,56) opens the same Unlock screen as hole 12. When entitled, replace its copy with “Full game unlocked” and a check, with no sales button. When paid content is unavailable, show “12 free holes available” without a purchase button. Do not invent locked placeholders for holes absent from the catalog.

Unplayed: Play footer and no earned stars. Current: selectedEdge/Next label. Completed: actual best and earned stars. Locked paid card: Full game/lock; tapping opens offer with that hole as intended destination. Empty catalog is an error, not first run: replace grid with card `(16,Y,328,112)` saying “Holes couldn’t load” and Retry atsingleFooter. Returning after unlock preserves scroll and refreshes locks. Stars are3 under par,2 at par,1 finished above par; unplayed0.

## 5. Settings

**Primary:** Done; toggles change immediately with no Save button. Components: top bar, card containing five toggle rows, secondary Reset progress, primary Done, version caption. Motion: `toggleSlide`, `controlAppear`, `parkTravel`, `sheetIn/Out` for reset.

Top bar back returns to caller. Settings card `(16,Y,328,320)` contains rows64 high in this order: Sound, Music, Vibration, Reduced motion, Colorblind aim. Label area `(28,Y+i*64+12,208,40)`; toggle track `(280,Y+i*64+18,52,28)`. The row's full328×64 is the one hit target (the knob must not double-toggle). Show On/Off next to track using caption in the label area; when the OS forces motion reduction, use second line “Reduced by device setting”. No separate Screen shake row; Pocket Park has no camera shake. Older saves migrate missing settings to false without losing scores/entitlement.

Card body is scrollable if larger text/insets require it; ends by A-144. Reset secondary `(16,A-132,328,56)`; Done `(16,A-56,328,56)`. Version caption sits in the20px gap above Done, at A-76, caption 18. Baseline card ends 424, reset starts 468; short ends 423/reset491; tall ends 450/reset603.279. Thus five rows fit without overlap in all fixtures.

Sound/music/vibration apply to audio/haptics only; show “Unavailable on this device” and disabled stored state if haptics cannot be used. Effective reduced motion is saved-toggle OR OS setting; toggling off never overrides OS reduce. Colorblind aim changes existing preview ink/pattern immediately; it does not change trajectory. Preferences save asynchronously; on error keep current session values and show save-failed toast. Done from Pause returns to the paused hole, not a newly started attempt.

### Reset-confirm sheet

**Primary:** Reset progress, destructive, only after this explicit confirmation. Panel `(16,A-280,328,280)` with title atlocal(16,24), type.screen; body at (16,68),296×66: “Clear scores and stars on this device? Your purchase and settings stay.” Cancel secondary atlocal(16,148,296,56), Reset progress destructive at (16,212,296,56). Heights/padding are fixed; sheet fully inside all fixture safe areas.

Back/scrim/Cancel dismisses without mutation. On Reset, dedupe the operation, show “Resetting…” on its disabled button; Cancel/back may close the sheet but must not pretend to undo a write already sent. Do not report success until local persistence succeeds. Preserve entitlement, settings and first-putt tutorial completion; clear hole attempts/scores/assist history and set a valid first hole. If persistence fails, retain the prior save and show “Couldn’t reset progress. Try again.” with Retry. Existing `clearSave()` resets more than this contract and requires builder correction; do not silently revoke a purchase as a side effect of resetting scores.

## 6. Play: HUD, course and aiming

**Primary:** putt by dragging back and releasing. Components: top bar, pause icon, score block, course sprites, static tee/cup, aim pattern, power card; optional Assist control. Motion: `aimAcquire`, `puttRelease`, `ballRoll`, all contact effects in motion.md; idle decorations stop during play.

HUD `(0,T,360,64)`: Pause `(16,T+4,56,56)`; title region `(80,T+6,152,52)`, first line “Hole N” caption 18 and second hole name type.hole 26, ellipsized to 152; right score region `(240,T+8,104,48)` with “N strokes” body 22 and “Par P” caption 18. Do not squeeze hole title under an oversized stroke chip. An error toast cannot cover Pause.

Course viewport is `(16,T+72,328,A-(T+72)-76)`. Let `ch=A-(T+72)-76`, `q=min(328/360,ch/640)`, `ox=180-180*q`, `oy=T+72+(ch-640*q)/2`. Map world point `(wx,wy)` to UI `(ox+q*wx,oy+q*wy)`. Invert this same transform for aiming; do not use raw CSS coordinates as physics coordinates. All360×640 world bounds fit uncropped; no independent x/y scale and no perspective. The ball radius remains7 world units, cup11. Downscale course only, not UI labels/hit targets.

| Fixture | Course viewport top / height | q | World origin ox / oy | Bottom power card top |
|---|---|---|---|---|
| Baseline |96 /428 |0.66875 |59.625 /96 |536 |
| Short |95 /452 |0.70625 |52.875 /95 |559 |
| Tall |122 /537.279 |0.839498 |28.890 /122 |671.279 |

Allow press to start a drag anywhere in the course viewport, preserving the current forgiving input behavior; teach starting from the ball with a56×56 minimum contact target centered on its rendered position. Neither a small ball nor a boundary-adjacent tee should require pixel precision. Drag vector is pointer-down minus current pointer, converted by 1/q to world units; preserve the existing drag-power scale 160 and minimum shot distance 8 **world units**. Maintain capture outside the viewport while dragging, except over system interruption; cancel on pointer cancellation/pause, never fire a putt from a cancelled gesture. Player-chosen taps on HUD/Assist must not initiate a shot.

Power panel `(16,A-64,328,64)`, radius 20, surface gradient. Atlocal(12,8), “Drag back to aim” while idle, “Release to putt” while aiming, “Ball rolling…” while moving, body 16. Numeric percent atlocal(260,8) right-aligned in 56 wide. Ten segments atlocal(12,40), each26.8×8, gap4, total 304. Meter always has numerical redundancy and does not pulse. Preview obeys current progress rules:0.6s ordinarily,1.6s with Assist. Do not substitute the study's illustrative frozen line or promise a guaranteed winning route; display only the actual available simulation preview.

Assist appears after the existing trigger (two consecutive finishes at least par+3, or8 strokes this attempt; enabled stays available). It is a56-high secondary action in the power card's rightmost112px while idle, text “Assist Off/On”; instruction text is confined to 180px and wraps if needed. While aiming, replace the interactive Assist action with a static “Assist On” caption in the instruction region if active; percent and meter use the full layout. After rest restore the action. Offer is optional; never auto-enable or put a modal in the shot path.

Rolling: ball and movers follow simulation; stroke count increments once on a valid putt. Water: add one penalty once, immediately show “Water · +1 penalty” in the power card for 2400ms or until the next drag, and reset to shot origin. HUD reflects strokes including penalty. Sand/slopes do not add penalties. Rim/lip-out are near misses; ball remains live. Invalid level during play shows the load error card and Back to holes primary, never a default empty level that looks playable.

### First-time hint

Shown only for a save with no valid first putt and no previously completed tutorial. No separate modal. After1800ms resting/no interaction, overlay ghost hand near the real ball; maximum 56×56 hand and a48px backward path, clipped to course viewport. Choose a demonstrative aim toward the cup and clip travel to remain in bounds; do not claim that direct route is safe. Bottom power card reads “Drag back, release to putt”. Up to two cycles; afterwards leave only the instruction. Any play-area touch dismisses the ghost immediately and starts a real drag. Mark tutorial seen on first valid putt, not on a mere tap. Reduced motion uses static hand/path. Never emit a tutorial shot, increment strokes or block aiming. If save fails, keep seen in memory for this session and use save-failed feedback.

## 7. Pause sheet

**Primary:** Resume. Components: scrim, sheet, primary pill, three secondary pills, Close icon. Panel `(16,A-368,328,368)`; title local (16,24); close `(256,12,56,56)`; optional hole/par caption at (16,66); Restart hole `(16,100,296,56)`, Holes atlocal y164, Settings y228, then primary Resume y292, same width/height. Resume therefore stays in the bottom third. Motion: `sheetIn/Out` only, no park pan when opening/closing.

Freeze simulation, movers, ambient/course effects and music as appropriate atopen; cancel partial aim without adding a stroke. Resume takes effect on valid tap even if sheet is entering/exiting. Restart starts this same valid hole with 0 strokes and a new attempt; show no fake “saved checkpoint”. Holes leaves the active attempt; completed bests remain saved. Settings navigates to bench while retaining paused session. Back/scrim/Close equals Resume. App backgrounding returns here. Result state uses its own Back behavior, not a Pause sheet stacked over rewards. Any current save error remains available as a toast above the sheet; no blank toggle block overflowing its bottom.

## 8. Hole-complete result and celebration

**Primary:** Next hole, Continue after hole 12, or Back to holes at last available entitled hole. Components: result card, star row, score, best chip, primary, Retry and Holes secondary. Motion: `ballDrop`, `flagWiggle`, `holeReward`, `starPop`, `strokeReveal`, `bestBadge`, sheet entrance. Values and actions appear at F0; decoration continues≤800ms.

Panel `(16,A-332,328,332)`. Local positions: heading(16,16),296×40 type.display, label from existing `scoreLabel`; “Hole complete” caption(16,58). Star row centered at (164,92),108×32; stroke number at (16,116),72×44 and “strokes · par P” at (96,128),216×22. Best/first-finish badge(16,166),296×28. Primary `(16,200,296,56)`. Retry `(16,268,142,56)` and Holes `(170,268,142,56)`. At baseline primary screen top 468; short491; tall603.279. Current result stars use this score; compare previous saved best **before** updating it to decide a personal-best badge.

First finish uses “First finish”; strict improvement uses “Personal best · N”; tie/worse uses “Best N”. Do not label a first-ever score a broken record. Save failure leaves score/reward visible with an honest toast; Next continues in memory. Retry restarts the same hole immediately. Holes opens selection immediately. Back behaves like Holes; scrim is inert to avoid accidental dismissal into a holed course.

For a non-entitled player finishing hole 12, **Continue** opens Unlock; no automatic paywall at drop time. For entitled players, advance only to an existing playable next hole. End of catalog says “All available holes complete” in badge region and **Back to holes**, with Retry still present; never modulo-wrap to hole 1 under a misleading Next label.

## 9. Unlock after hole 12 / full-game offer

**Primary:** Unlock full game at the verified store price when available. Components: top bar/back, feature card, one primary purchase pill, Restore purchases secondary, Keep playing free holes secondary. Motion: `unlockAppear` plus park travel; no urgency animation. The same screen handles entry from hole 12, locked hole card or full-game panel, preserving origin/intended hole.

Top bar title “Full game”. Body scroll viewport `(16,Y,328,A-234-Y)`; feature card minimum 224 high. Local contents: title “Unlock full game” at (16,16), type.screen34; exact offer description at (16,58),296×66: “Get holes 13–{total}: {paidCount} more holes. One purchase.” Use real catalog totals and include any genuine included features, never promises of future levels. Below at (16,136),296×66 body: “Play offline. No ads. No subscription.” Do not imply purchases/restores themselves work offline.

Price/support caption `(16,A-210,328,18)` reads “One-time purchase” when price ready. `offerFooter`: purchase topA-184 with label “Unlock · {localizedPrice}”; Restore purchases at A-120; Keep playing free holes at A-56. Baseline tops416/480/544, short439/503/567, tall551.279/615.279/679.279. Only purchase has coral fill; both alternatives remain full-size and visible without scrolling. Long store price wraps to two action lines, no truncation, substituted currency or baked “$2.99”. Store price is display data from the store, represented in design fixtures as `{localizedPrice}` only.

| Offer state | Exact treatment and action |
|---|---|
| Price loading, paid content exists | Purchase disabled, “Loading price…”; support “Store price is loading”. Restore/free replay/back remain available if their operations are supported. |
| Ready | Price from successful product lookup; tap starts exactly one store request immediately. Record intended destination. |
| Store opening / purchase pending | Purchase disabled “Opening store…” then “Waiting for store”; support “Complete your purchase in the store.” Keep free replay/back available in the app when platform overlay permits; do not launch a second request or synthesize success on timeout. |
| Offline or lookup error | No guessed price. Caption “Store unavailable. Free holes still work.” Disabled purchase says “Price unavailable”. Add Retry lookup as56×56 secondary inside scroll body after feature copy; free replay remains the primary usable footer action (coral). Restore may attempt store access and return its own clear error. |
| Paid content or billing not shipped | Feature copy “The12 free holes are ready to play. Full-game unlock isn’t available in this build.” No enabled buy action or invented hole count. Keep free replay is primary at A-56; Restore at A-120 is enabled only with a real restore backend, otherwise show “Restore unavailable in this build” as supporting text and omit its button. |
| Already entitled | Replace offer with success state; never show a Buy button for the same entitlement. |

**Current implementation gap:** this workspace bundles only holes 1–12 and `requestUnlock()` returns false as a stub. The unavailable variant above is the truthful current-build screen. Ready/purchase/success screenshots in the dev gallery must carry a visible “Store fixture” badge until real catalog/billing exists. Do not ship a mock successful purchase.

Keep playing free holes goes to Hole select showing available 1–12, not back into an offer loop. Back returns to invoking screen: hole 12 result, locked-card selection or menu path. Successful purchase routes through section10; cancelled/failed routes to section12. Do not navigate to hole 13 unless it exists and entitlement is verified.

## 10. Unlock success

**Primary:** Play hole 13 when it exists; otherwise Back to holes. Components: top bar/back, check badge, card, primary, secondary Holes. Motion: `unlockSuccess`. Layout: success card `(16,Y,328,224)`; check circle56 atlocal(136,16); heading centered in(16,88,296,40) “Full game unlocked”; body(16,140,296,66): “Your purchase is ready. All {total} holes are available.” Use real totals. Paired footer primary at A-120, Holes at A-56. If launched for a selected paid hole, primary instead says “Play hole N” for that valid intended hole.

Only a verified purchase/restore grants entitlement; price lookup, timer completion and button animation cannot. Persist entitlement, refresh locks and acknowledge the transaction according to the billing implementation. If entitlement exists but expected paid data cannot load, card says “Purchase restored. Holes couldn’t load.” with Retry content primary; free Holes secondary remains usable. If persistence fails after verified purchase, do not report “purchase failed” or sell again: show “Unlocked for this session. Couldn’t save on this device.” with save Retry; retain verified entitlement in memory. Back returns to Holes, not a duplicate purchase flow. No second purchase confirmation loop.

## 11. Restore purchases result

**Primary:** outcome-specific acknowledgement. Components: sheet/card, check/info/error badge, one primary, secondary free replay if needed. Motion: `restoreResult`; no camera travel if invoked within the pavilion. While pending, keep source page and disable only Restore with “Restoring…”. Back/free replay stays usable; result arriving after navigation updates entitlement without dragging the user back to the old page.

Result panel `(16,A-280,328,280)`; badge(16,20), title(48,20), body(16,64,296,66), primary(16,148,296,56), secondary(16,212,296,56). Body labels wrap; primary has coral fill. Store outcome is not inferred from elapsed time.

- **Restored:** “Purchase restored” / “Your full-game unlock is available.” Primary Play hole 13 (or intended existing hole); secondary Holes. If content unavailable use section10 error variant.
- **Nothing found:** “No purchase found” / “No full-game purchase was found for this store account.” Primary **OK** returns to offer; secondary **Free holes**. Do not imply that ownership was revoked elsewhere.
- **Failed/offline:** “Couldn’t restore” / “The store couldn’t be reached. Try again when it’s available.” Primary **Try again**; secondary **Free holes**. Do not show a zero-purchases success result on network failure.
- **Cancelled:** dismiss pending state, keep source page; show “Restore cancelled” toast, not a red failure screen.

Restoring a purchase does not restore scores stored only on another device; include “Scores stay on this device” in restored result support text when space permits, otherwise replace the generic success body with it. Preserve current local scores. Back/scrim dismisses result; no mandatory acknowledgement delay.

## 12. Purchase failed/cancelled and toast placement

Toasts occupy `(16,toastY,328,toastH)`, H64–108. On a normal page, `toastY=max(Y,footerTop-12-toastH)`, where footerTop is the first fixed action in that screen's footer; on Menu it isA-156, Unlock A-184, Settings A-132, Play A-64. On sheets/results, place above the panel: `toastY=max(T+72,panelTop-12-toastH)`. If insufficient vertical space, place an inline message inside the sheet's body and allow that body to scroll; never cover its action rows or top-bar Pause/Back. Text color is text; severity changes the icon only. Accessible announcement once, no repeated alarm sound.

**Purchase cancelled:** “Purchase cancelled.” Info icon, no blame, no claim about charges. Hold4s, return purchase button to verified-price Ready state. No auto-retry. **Purchase failed:** “Purchase didn’t complete. Try again.” Error icon; persist until dismissed/resolved; Retry64×56 revalidates product/store state before a new user-requested purchase. Keep free replay/back available. An unknown/pending store transaction stays pending with explanatory text, not falsely marked failed or charged; Retry must not duplicate it.

Toast with action: message text region224px wide minus its icon/gap/padding; action64×56 at right. Three lines max; for longer text replace underlying support copy instead of making a huge toast. Only one toast at a time. Save errors outrank routine cancelled messages. Close action, if present instead of Retry, also has56×56 target. Component lifetime follows motion.md, with readable static content from first frame.

## 13. Save failures, empty state and offline

**Save-failed toast:** “Couldn’t save. Progress may be lost when you close.” Error icon, Retry action; keep current progress in memory and continue play. Never say “Saved” after a swallowed exception. Retry attempts the latest full save snapshot, not an old attempt, and coalesces repeated requests. Success replaces toast with “Progress saved” for 4s. Leaving a screen cannot silently clear the unresolved failure; show the message in the next safe toast slot. Reset failures use the separate transactional behavior in section5.

**Save read failure/corruption:** distinguish from a missing save. On Menu use informational card in the hero region, width 328 and height 112, message “Couldn’t read your progress.” with **Retry** primary in the regular menu primary slot and **Play this session** secondary in its Holes slot. A caption warns “Session progress won’t replace your stored save.” Preserve raw stored data and entitlement evidence; do not overwrite on boot/attempt start. Once the user chooses session play, all available free holes remain playable; only restore verified entitlement, never guess it from unreadable data. No automatic destructive repair. Builders need explicit persistence result/error reporting: current `platform/save.ts` swallows read/write errors, so it cannot honestly support these states unchanged.

**Empty/first run:** valid absence of saved progress leads to Menu Play, no empty grid, no error banner, no stars awarded. All twelve free holes visible/available. First valid putt runs the first-time hint policy. Settings defaults Sound/Music/Vibration on when supported, Reduced motion/Colorblind aim off, with OS reduction still applied. Restore stays discoverable on the offer; first run never requires buying.

**Offline:** ordinary state, not an error screen. Bundled fonts, levels, art, sounds and local progress operate offline with the same menu/play/select/result layouts and motions. No persistent “offline” warning covering the course. Only store-dependent actions report store unavailability; owned bundled holes remain unlocked from a valid local entitlement. Save failures indicate actual device storage failures, not network absence. No accounts, ads, analytics or data-collection screens.

## 14. Dev-only component gallery scene

**Primary:** select/replay a specimen, for builder/reviewer use only. Proposed scene key `ComponentGallery`; register only in development builds (`import.meta.env.DEV` or equivalent build-time guard), never via a visible production-menu button. A development query/shortcut may open it; production builds ignore it and do not expose fixture purchase controls.

Use top bar atT titled “Component gallery”, persistent caption “DEV · fixture data”. Main viewport `(16,Y,328,A-Y-144)` vertically scrolls specimen cards; paired footer **Replay effect** at A-120 and **Next specimen** at A-56. Page dots centered at (CX,A-138) only when≤5 specimens in a group; otherwise caption “n of N”. Each group lists an exact state label above its specimen, never relying on color to label the state. Fixture settings buttons are inside the scroll area and56px high.

Required groups: palette/type/shadow swatches; primary/secondary/destructive/icon controls in all seven shared states; chip/toggle/card; unlocked/current/completed0–3/locked hole cards; star row/lock badge/top bar/progress dots; sheet/result/toast; course mechanics; screen fixtures. Inert specimens explicitly label Pressed/Focus N/A. Disabled specimens show the reason text. Selected controls show their real check/text treatment. Focus uses the real ring and keyboard order.

Provide selectors for baseline/short/tall layout, actual safe-inset values, reduced motion, simulated OS reduce, colorblind aim, sound on/off, worst-case long localized price, first run/progress,1/2/3 stars, strict best/tie/worse, every store result and storage failure. Label all injected data “Fixture”, especially entitlement/store price. Real store/persistence writes must never be invoked by a specimen button.

Freeze effects at named motion checkpoints (0/80/160/240/400/800ms) and permit replay/cancel/rapid re-entry. Show debug hit rectangles, world collision outlines, layer IDs, effective motion policy, particle/sprite/tween counts and owned texture bytes in the optional dev overlay. Course fixtures include real hole 5 geometry, hole 9 corners/bumper, plus real catalog holes containing sand/movers; no edited gameplay data. Gallery renders actual shared components, not parallel HTML imitations. On exit, all fixture listeners/textures/timers are released.

## Screenshot review checklist

Capture every fixture at 320×568 and430×932 with safe insets above; include360×640 reference and normal/reduced-motion pairs. These are required future builder proofs, not screenshots already produced by this docs-only job.

- [ ] Boot mark/loading/error and font fallback have a visible retry path without fallback-font flash.
- [ ] Menu first run/progress/all-finished layouts keep their primary action in the lower third and clear of home/status areas.
- [ ] Hole grid shows unplayed/current/completed/locked, scrolled bottom, entitled and unavailable full-game panels; no tiny targets.
- [ ] Five settings toggles, OS-forced reduction, colorblind aim, haptics unavailable and reset confirmation fit without overlap.
- [ ] Reset copy explicitly preserves purchase/settings; reset failure stays honest.
- [ ] Play HUD,0/70/100% aim, rolling, first-time hint and Assist states fit all fixtures with uncropped course geometry.
- [ ] Water shows shot-origin reset and penalty; sand/slopes/movers/cup states match actual mechanisms.
- [ ] Pause sheet actions fit; simulation state and aiming are not drawn as active underneath it.
- [ ] Result1/2/3 stars, first finish/best/tie, hole 12 Continue and final-hole Back to holes all show Next/action at F0.
- [ ] Unlock Ready/loading/offline/unavailable/pending views show exact included content, store price only when known, Restore and free replay paths.
- [ ] Verified success, restore found/nothing/error/cancelled and missing paid-content variants have correct primary actions.
- [ ] Purchase failure/cancellation, save failure/retry and save-read recovery never cover a primary button or claim false success.
- [ ] Offline screenshots retain normal play; paid fixtures are visibly marked and cannot be mistaken for shipped billing.
- [ ] Dev gallery exposes every component state, effect checkpoint and touch/collision debug overlay; production has no gallery entry.
