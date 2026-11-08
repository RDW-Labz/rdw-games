# Pocket Park design system

Status: implementation specification, 2026-10-12. Lead direction: [Pocket Park, section 02](directions.md#02--pocket-park), [menu study](../../design/directions/pocket-park/menu.html), [play study](../../design/directions/pocket-park/play.html). This document supersedes the old neon guide and the studies wherever values differ. Companion contracts: [motion](motion.md), [screens](screens.md), [product brief](brief.md), [mechanics](../level-format.md).

Build a small, tactile park: cream clay rails, mown felt, painted ponds, ceramic ball, coral actions. Gameplay stays overhead. Menu art may tilt; collision geometry never does. The studies use 390×844 compositions; the specifications below use 360×640 baseline logical UI pixels. Do not copy study CSS dimensions into the game.

## 1. Token source and ownership

`src/ui/tokens.ts` is the **only authored source of presentation colors and sizes**, including screen placement constants, material dimensions, effect amplitudes, timing, opacity, spacing and depth. Replace its neon values; do not create a second palette in `game/theme.ts`, scene files, CSS, font helpers or texture builders. These docs specify the future module; this job does not change code.

The module exports this shape; each named group contains the literal keys specified below and in the companion documents. Use `as const` on the value object; no arbitrary string-key dictionary or runtime theme mutation.

```ts
export const TOKENS = {
  color, type, space, radius, stroke, shadow, depth,
  component, course, layout, motion, budget,
} as const;
export type UiTokens = typeof TOKENS;
export type ColorToken = keyof UiTokens['color'];
export type TypeToken = keyof UiTokens['type'];
export type DepthToken = keyof UiTokens['depth'];
export const DEPTH = TOKENS.depth;
export function cssColor(key: ColorToken): string;
```

`color` values are numeric `0xRRGGBB` (shown as hex below). `cssColor` returns padded six-digit `#rrggbb`; never use a decimal `.toString()` as a CSS color. Alpha is separate. `type` values have `{family, size, weight, lineHeight, tracking}`. `space`, `radius`, `stroke`, `depth`, `budget` are named numeric records. `shadow` values are arrays of `{dx,dy,spread,alpha,color: ColorToken}`; `component`, `course`, `layout`, `motion` are nested objects with the named fields below. Gradient recipes are pairs of color keys, oriented top to bottom unless specified. Resolve token keys to numeric colors at draw time.

`layout` contains baseline dimensions, viewport formulas' constants and named screen recipes from screens.md; `motion` contains `duration`, `ease`, `effect` (one camelCase key per effect-table row) and `parkMap` from motion.md. Every numeric presentation value in these three docs belongs to those groups, not as literals in its consumer. Derived values (half height, safe inset conversion, measured text width, viewport fit) are computed from tokens. Store state and content are data, not tokens.

Level vertices, mover dimensions/periods, ball/cup collision radii, force vectors, scoring and physics thresholds stay owned by level/simulation modules. Import them; never duplicate physics values in UI tokens. Numbers shown here for those mechanics are verification references, not alternate configuration. `game/theme.ts` may temporarily re-export token aliases; it must not retain independent colors, sizes or depths. Migrate `fonts.ts`, `textures.ts`, `render.ts`, `juice.ts` and every scene to this contract together. Generated art stays in code; no network fonts, runtime image service or downloaded art.

## 2. Semantic color tokens

Each row is one or more exact keys in `TOKENS.color`. Text on gradients must pass at **both** endpoints. Normal text requires 4.5:1; essential outlines and control state indicators require 3:1 against adjacent fill. Do not put white text on the coral primary. Decorative borders are not focus/selection indicators.

| Keys | Exact values | Meaning |
|---|---|---|
| `bgTop`, `bgBottom`, `bgLight` | `#FAF3DF`, `#EEE8CF`, `#FAE0B9` | Warm sky/backdrop; baked upper-right light patch |
| `surfaceTop`, `surfaceBottom` | `#FFFBEE`, `#F1E8D0` | Cards, secondary pills, top bar |
| `raisedTop`, `raisedBottom` | `#FFF9E9`, `#FFFDF4` | Sheets, result, toast |
| `primaryTop`, `primaryBottom`, `onPrimary` | `#F58E6C`, `#ED7759`, `#43271F` | Primary action |
| `primaryEdge`, `primaryHighlight` | `#CF6248`, `#FFBC94` | Clay underside and top highlight |
| `secondary`, `text`, `textMuted` | `#5C8963`, `#354B3A`, `#626950` | Botanical accent; primary and supporting text |
| `border`, `controlEdge`, `highlight`, `shadow` | `#D5C8A6`, `#626950`, `#FFFFFF`, `#7E6E41` | Decorative border, functional outline, bevel, warm shadow |
| `focus`, `selectedFill`, `selectedEdge` | `#354B3A`, `#E1EDD3`, `#38674C` | Focus ring; selected card/chip |
| `disabledFill`, `disabledText` | `#E3DDCC`, `#354B3A` | Opaque unavailable controls; retain readable text |
| `success`, `warning`, `danger` | `#38674C`, `#8D621A`, `#AE403B` | Text plus check/info/error icon; never color alone |
| `dangerTop`, `dangerBottom`, `onDanger` | `#AE403B`, `#943630`, `#FFFFFF` | Destructive pill |
| `scrim` | `#354B3A` | At alpha 0.32 behind sheets/results |
| `turfTop`, `turfBottom`, `turfEdge`, `turfGrain` | `#B3D28B`, `#87B36F`, `#887653`, `#354B3A` | Felt island and outside extrusion |
| `rail`, `railUnder`, `railHighlight` | `#FAF1D7`, `#B49A71`, `#FFFDF4` | Cream wood/clay rails |
| `sand`, `sandLight`, `sandDot` | `#E5C786`, `#F4DFA8`, `#8D621A` | Sand fill, edge, speckles |
| `waterTop`, `waterBottom`, `waterEdge`, `waterRipple` | `#64B7C6`, `#338696`, `#276B78`, `#E1F9FF` | Pond gradient, inset contour, ripples |
| `slope`, `slopeArrow` | `#D6D294`, `#354B3A` | Sage patch and dark direction marks |
| `mover`, `moverEdge`, `moverHighlight` | `#BC665C`, `#743E38`, `#F0B5A7` | Toy slider; track uses moverEdge |
| `bumper`, `bumperEdge`, `bumperHighlight` | `#A58BC2`, `#59456F`, `#DACBE9` | Rubber puck with light crown |
| `cup`, `cupDeep`, `flag`, `flagFold` | `#354B3A`, `#203428`, `#DB6246`, `#AD4930` | Well and cloth; pole uses rail |
| `ballLight`, `ballMid`, `ballShade`, `ballMark` | `#FFFFFF`, `#F2F7E9`, `#B9CBB8`, `#626950` | Ceramic shading, seam |
| `tee`, `tree`, `treeLight`, `trunk`, `flower` | `#354B3A`, `#5C8963`, `#80A776`, `#816B45`, `#F58E6C` | Tee ring and outside-only planting |
| `star`, `starEdge`, `starEmpty` | `#F3C76B`, `#8D621A`, `#D5C8A6` | Gold filled stars, readable outline, empty interior |
| `aimLow`, `aimMid`, `aimHigh` | `#3B6659`, `#AD4930`, `#764A7B` | Low <0.5, mid 0.5–<0.85, high ≥0.85 |
| `aimAccessible`, `aimBacking` | `#354B3A`, `#FFF9E9` | Colorblind-safe dark line on cream backing |

Aim always has a cream 5-unit backing with a 2-unit colored core. Colorblind aim replaces every power-dependent ink with `aimAccessible`, preserving numbers and patterns: low dots 2-on/8-off, medium dashes 8-on/6-off, high solid. Normal mode also uses these patterns. The ten-segment meter displays `round(power*100)%`; fill `floor(power*10)` segments, with all ten at 100%. No pulse while held. SlopeArrow intentionally uses darker ink than the early study. Terrain identification uses ripples, sand dots, slope arrows and mover tracks as well as hue.

## 3. Typography and geometry

Bundle `public/fonts/Fredoka-Variable.ttf` and `public/fonts/Nunito-Variable.ttf`. Wait for both to load before text-bearing screens; boot may show only the baked mark. Missing fonts show the font-load error in screens.md, never a visible system-font substitution. Use actual weights, not synthetic bold. Tracking is logical px; no all-caps paragraph copy.

| `type` key | Family | Size / line height | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `logo` | Fredoka | 56 / 52 | 600 | -1 | Two-line menu wordmark only |
| `display` | Fredoka | 34 / 40 | 600 | 0 | Result/success heading |
| `screen` | Fredoka | 28 / 34 | 600 | 0 | Screen and sheet titles |
| `hole` | Fredoka | 20 / 26 | 500 | 0 | Hole title/card number |
| `action` | Fredoka | 20 / 24 | 600 | 0 | Primary button |
| `number` | Fredoka | 40 / 44 | 600 | 0 | Result stroke count |
| `body` | Nunito | 16 / 22 | 600 | 0 | Explanatory text |
| `label` | Nunito | 16 / 22 | 800 | 0 | Settings, secondary button |
| `caption` | Nunito | 13 / 18 | 700 | 0 | Par, progress, price note |

Floor is 13 logical px. Render text at device pixel ratio capped at 3; do not shrink font size to fit. Wrap body copy; ellipsize only hole names with their full name available on the result/select view. Reserve numeric widths using the widest measured digits so strokes/power do not shift neighboring UI. Keep text rigid during button depression: animate its y only, scale the background separately.

`space = { none:0, hair:1, xxs:2, xs:4, sm:8, md:12, lg:16, xl:24, xxl:32, xxxl:48 }`.

`radius = { small:8, card:20, panel:24, sheet:28, power:20 }`; pills/chips/circles use half their height. `stroke = { border:1, mechanic:2, selected:2, focus:3 }`. Outer focus offset is 3. Do not square off cards when resizing.

### Shadows, drawable in Phaser 4

Use these stacked rounded silhouettes **behind** a baked fill; no runtime blur. Spread expands all sides and increases radius by the same amount. All layers use `color.shadow`, except the primary contact layer. Bake transparent texture padding of 24 on every side; texture/image origin corresponds to the unpadded face. Never crop the shadow into a face-sized canvas.

| `shadow` recipe | Back-to-front layers `{dx,dy,spread,alpha,color}` |
|---|---|
| `small` | `{0,5,3,0.06,shadow}`, `{0,2,0,0.12,shadow}` |
| `card` | `{0,10,6,0.05,shadow}`, `{0,5,2,0.09,shadow}`, `{0,2,0,0.10,shadow}` |
| `sheet` | `{0,12,8,0.06,shadow}`, `{0,6,3,0.10,shadow}`, `{0,2,0,0.12,shadow}` |
| `primary` | `{0,10,5,0.08,shadow}`, `{0,5,0,1,primaryEdge}` |
| `pressed` | `{0,2,0,0.12,shadow}` |

Every face gets a 1px top inset highlight at alpha 0.65; primary uses a 2px `primaryHighlight` at alpha 1. Bottom sheets retain rounded top and bottom corners inside the safe area. Gradients may be baked with Canvas2D once and uploaded as textures; no per-frame gradient creation or reliance on a CSS box-shadow inside Phaser.

### Named depth constants

`depth = { background:0, ambient:10, decoration:20, islandShadow:30, island:40, terrain:50, track:60, rail:70, cup:80, contactShadow:90, ball:100, flag:110, aim:120, courseFx:130, hud:200, screenTransition:250, scrim:300, sheet:310, sheetContent:320, toast:400, focus:410, dev:900 }`.

Use parent-container ordering deliberately: child depth cannot escape a parent's display list. HUD, sheet and toast each have their own root; focus is attached to the active control and clipped to its owning viewport. A cup foreground lip may sit above a falling ball *inside the cup group*; only the visual drop clone moves there. ScreenTransition holds decorative snapshots only; active controls remain on hud/sheet layers and receive input immediately.

## 4. Component contract

All positions refer to the unscaled face and permanent hit rectangle, not shadow bounds. Baseline full width is 328 (360 minus two 16 gutters). Inner sheet controls are 296 wide (16 inner gutters). Every actionable region is at least **56×56 logical**, therefore at least 49.8×49.8 CSS px on 320px phones. Decorative chips/stars/dots are not tiny buttons. Expand an interactive chip's hit box to 56 high; do not overlap adjacent targets. No target moves or shrinks with feedback.

### Shared states (applies to every row below)

- **Idle:** listed face at alpha 1, scale 1, original y; no looping control pulse.
- **Pressed:** immediate tint `text` at alpha 0.02, animate face scale 1→0.97 and face/label y +2 over `instant`; shadow becomes `pressed`. Label is never scaled. On valid pointer-up invoke action before starting release. Release returns to idle over `quick`. Pointer-out/cancel or scroll over 8 logical px cancels activation and resets feedback. Never execute in a tween completion callback.
- **Disabled:** opaque `disabledFill`/`disabledText`, no shadow or press tween; show a reason in supporting text. Remove activation but retain an accessible description. This differs from a locked hole, which can open the offer.
- **Selected:** `selectedFill`, `selectedEdge` 2px and a check/label; not color alone. Selection persists across press/release. Momentary buttons have no persistent selected state: use a checked completion label only if their real operation succeeds.
- **Focus:** 3px `focus` outline with 3px gap outside the face; independent of selected. Never keyboard-focus an inert decoration. Focus survives press and moves to the destination's title or primary control on navigation.
- **Appear:** `controlAppear` / `cardAppear` from motion.md, final hit area installed at creation. Label is visible immediately; only face/decor alpha/offset animates. Touching an entering control snaps its decoration and acts normally.
- **Exit:** `controlExit` fade, leaving controls unregister immediately. Already accepted actions continue; decorative clones never receive input.

Inert components explicitly inherit idle/appear/exit only; pressed/disabled/selected/focus are **not applicable**, not missing implementations. Composite components apply those states to their child controls; never scale a whole sheet or top bar when one child is pressed. State precedence: disabled > pressed decoration; selected underlays persist; focus overlays all enabled states.

| Component / token path | Exact face and padding | Idle treatment and content | State specialization |
|---|---|---|---|
| `component.pill.primary` | W328/H56/R28, padX24; inside sheet W296 | primaryTop→primaryBottom, onPrimary, type.action, shadow.primary | Shared states. Selected is transient confirmed check only. Busy uses disabled face plus “Opening store…”; navigation stays available. |
| `component.pill.secondary` | W328/H56/R28, padX24 | surfaceTop→surfaceBottom, text, type.label; 1px controlEdge, shadow.small | Shared states; selected only for an explicit selectable option. |
| `component.pill.destructive` | W296/H56/R28, padX24 | dangerTop→dangerBottom, onDanger, type.action, shadow.small | Only inside reset confirmation; pressed overlay highlight alpha 0.08 instead of dark tint. |
| `component.icon` | 56 circle, 22 icon, stroke 2 | surface gradient, controlEdge border, text icon, shadow.small | Shared; accessible name required; selected adds check dot 8 at face top-right, only for a true mode. |
| `component.chip` | H28, minW40, padX12, text caption; hit min56 if actionable | surface gradient/text, border 1, shadow.small | Read-only par/stroke chips inert. Selectable Assist chip follows shared states and says On/Off. |
| `component.toggle` | Track52×28/R14; knob22; inset 3; travel 24; rowH64, hit row width | Off disabledFill with controlEdge1; On success; knob raisedBottom; shadow.small under knob | Selected = On with check in knob and “On”; Off says “Off”. Press overlays track only, no knob scale. Entire row invokes once. Disabled still shows stored On/Off and reason. |
| `component.card` | W328, minH112, R20, pad 16 | surface gradient, border 1, shadow.card | Shared only if actionable; informational cards inert. Appear may translate 8px. |
| `component.holeCard` | W158/H152, R20, pad 12; 12 column/row gap | surface gradient, shadow.card; number/hole at local (12,12), par caption at (74,16); thumbnail134×56 at (12,42); footer at y112 | Unlocked: “Play”. Current: selectedEdge 2 plus “Next”. Completed: best-score caption plus star row. Locked: lock badge and “Full game”, full-contrast text; tapping opens Unlock, never launches Play. No gray haze over the number. |
| `component.starRow` | Small: 3×18 stars, gaps6, W66/H24. Result: 3×28, gaps12, W108/H32 | Filled star/starEdge1.5; unearned starEmpty fill/starEdge1; geometric five-point texture | Inert. 0–3 earned stars; no rating without completion. Appear pops earned stars only. Selected/pressed/etc N/A. |
| `component.lockBadge` | H28, padX8, 14 lock, gap6; width from caption | raised gradient, text lock and “Full game”; border 1 | Inert within card; parent handles input. Do not overlay stars or hide hole number. |
| `component.sheet` | W328, H by screen, R28, pad 16, handle32×4 | raised gradient, shadow.sheet; scrim 0.32 | Composite. Scrim intercepts course input for modal semantics, never for animation. Close/back works during entrance. Handle decorative; no ambiguous tap-to-drag dismissal. |
| `component.result` | W328/H332, R28, pad 16 | raised gradient, shadow.sheet; actual score, stars, best, next | Composite; actual values visible from F0. No whole-card press. Timeline in motion.md. |
| `component.toast` | W328/minH64/maxH108, R20, pad 12, icon20, gap8 | raised gradient/text; severity icon success/warning/danger; shadow.card | Inert text; optional Retry has 64×56 hit target and separate focus. Up to 3 text lines; no swipe requirement. |
| `component.topBar` | W360/H64, gutters16, left/right slots56, gap8 | surface gradient, border 1 bottom; shadow.small baked edge | Composite. Title uses type.screen, or play layout below. Back/pause icon responds instantly. No bar press state. |
| `component.progressDots` | 8 diameter, gap8, active20×8; total W=16*n+4 | inactive border; active success pill, caption “n of N” | Inert progress only, max 5 dots; larger count uses numeric label. Appear fade, selected=active data; no navigation dots with tiny targets. |

Hole-card footer mutually exclusive layout: completed gets stars at (12,112) and “Best N” at (86,112); current completed adds “Next” at local (42,16) in caption type, between the number and par, not over the footer; current unfinished says “Next” in footer; locked gets lock badge in footer; unplayed available says “Play”. Thumbnail depicts the actual hole, no invented hazards. Scroll containers clip visuals **and** input; only visible cards animate. Result stars reflect this attempt; hole-card stars reflect stored best.

## 5. Course art (world units; drawn in code)

Level data is authoritative. Keep every wall centerline, hazard polygon, tee/cup location and collision radius unchanged. No perspective, camera shake or decorative rail widening changes what the ball can hit. Material texture is subordinate to the route. The course transform is uniform and invertible; see screens.md.

| Element / `course` key | Exact drawing recipe | Performance ownership |
|---|---|---|
| Turf island / `island` | Fill exact closed boundary turfTop→turfBottom. Extrude downward9 in turfEdge alpha 0.40; mask extrusion outside original polygon. Outside shadow silhouettes offsets (0,10)/(0,14), spread4/8, alpha 0.10/0.05. Raised edge never paints over a playable lane. | Bake once per hole, including outside shadow. No runtime mesh or dynamic light. |
| Mowing / `mowing` | Alternating32-wide strips on a64 repeat, rotation−24°, highlight alpha 0.065 clipped to turf. Deterministic17×19 grain tile, dots radii0.7/0.6 at (3,4)/(12,14), alpha 0.08. Exclude water/sand. | Bake with island; seeded grain never regenerated per frame. |
| Rails / `rail` | Centerline backing11 railUnder; core6 rail; rounded joins/caps; highlight1 offset(0,−1), shadow 2 offset(0,2) alpha 0.18. Interior rail backing10. Optional wood seams every32, length 2, alpha 0.15, baked. | Static rail bake. On hit overlay one24-long highlight/cap sprite centered at contact. Flex its decorative highlight only by 1px; keep collision silhouette/core fixed. |
| Sand / `sand` | Exact polygon sand gradient to sandLight. Inner2px soft band using alpha 0.35. Deterministic dots radius 0.8 at minimum 6 spacing, sandDot alpha 0.25. No spill beyond polygon. | Bake fill/dots/edge once; event puff uses pooled sprites. |
| Water / `water` | Exact polygon waterTop→waterBottom; inner2 waterEdge contour. Broken ripple tile32×26, line 1.4 waterRipple alpha 0.27. | Bake pond and ripple pattern. Up to 2 ring sprites total on water contact; no continuously redrawn water. |
| Slopes / `slope` | slope fill alpha 0.75; highlight at upstream edge alpha 0.10. Chevron strokes2, length 10, grid 26×27, aligned with `atan2(forceY,forceX)`; zero force gets no arrow. Arrow ink slopeArrow alpha 1. | Bake patch/arrows; at most1 overlay patch alpha tween for a newly entered slope. No scrolling UV/shader. |
| Movers / `mover` | Match level width/thickness and simulation orientation; radius=min(4,thickness/2). moverEdge underbody, mover face, highlight1, two inset 2 end dots. Dashed4-on/4-off path from/to in moverEdge alpha 0.5. | Bake track. One body sprite and one attached shadow per mover; update transforms from authoritative simulation time, not a separate tween clock. |
| Bumpers / `bumper` | Match level radius. bumperEdge2 contact rim; bumper body inset 2; bumperHighlight crown radius 0.55*r offset(−0.15*r,−0.15*r); tiny three-bar spring mark in center. Never a dark cup-like center. | Bake puck texture; animate crown only for boing so fixed contact rim stays truthful. |
| Cup / `cup` | Radius11 from sim; cupDeep center with cup inner crescent offset(0,2); rail lip1.5 at radius 11, flag tint target ring radius 14 alpha 0.24. Fixed pole width 2/height 38, cloth24×16 with fold stripe2. Cloth pivot at pole top. | Bake well/pole; separate cloth sprite and drop mask/lip. Cloth at rest is static; wiggle only on successful drop. |
| Ball / `ball` | Radius7 from sim; radial highlight at (−0.3*r,−0.3*r), stops0 ballLight/0.6 ballMid/1 ballShade. Contact ellipse14×5 at y+3 in text alpha 0.22. Roll indicator: arc stroke 1, radius 4, length 4, ballMark alpha 0.5. | Shaded ball texture + shadow + clipped seam sprite. Translate with sim; seam rotation=travel/r, only while moving; disable seam motion in reduced motion. No continuous trail. |
| Tee / `tee` | Broken ring radius 10, stroke 1, tee alpha 0.45, two opposing ticks3 long. Behind ball, never looks like a cup. | Static bake; may remain during a hole. No pulse. |
| Trees / `trees` | Outside-only trunks6×20; canopies overlapping circles radii14/20 with tree/treeLight; small baked shadow. At most3 canopy groups visible. | Trunk/shadow static; menu canopy sprites pivot at trunk top. Gameplay trees static. |
| Bushes and flowers / `planting` | Bush circles radii6/10/14; flowers four radius 2 petals and sandLight center1; groups separated12. Outside course plus an18-unit clearance, including full sway/shadow extents; exclude mover sweep and all HUD bounds. | Bake all gameplay planting; omit when no clear space. Menu island artwork has its own non-playable composition. |

Event contacts need correct coordinates. Existing `SimEvent` has no contact position/normal/object ID, and water has already reset the ball before rendering consumes it. Builders must capture those values at the event source or provide a read-only event adapter before implementing localized squash/splash/flex. Do not guess the splash at the reset ball, infer a bumper by arbitrary nearest distance, or alter physics to make art easier. `rim` and `lip-out` must never trigger success. Water resets to **shot origin**, with one penalty added once, not a guaranteed return to tee.

## 6. Performance and lifecycle

Target a stable 60fps (16.67ms frame interval) on supported phones, not merely an average over an empty menu. These are implementation gates, not measured results of this docs-only job. Existing [baseline](baseline/README.md) shows poor throttled frame rates; do not claim current code already meets this target.

`budget = { ambientSprites:8, liveParticles:24, celebrationParticles:12, splashParticles:6, sandParticles:4, launchParticles:2, impactHighlights:2, ringSprites:2, dynamicCourseSprites:32, effectTweens:24, transitionSnapshots:1, transientTextureMiB:24, textureEdgeMax:2048, textureDprMax:2, textDprMax:3 }`.

Bake static background/planting, board/terrain/rails and component faces once per hole/screen (cache equal-size component textures within that screen). Ambient motion means transforms/alpha on a few already-baked sprites. **No per-frame Graphics redraws** for ambient, ball shading, cup, movers, bumpers or particles. Aim geometry may update only when drag input or preview data changes; use pooled line marks (cap 64) and reuse buffers. Physics-driven sprite transforms are expected.

Allocate at most one outgoing screen snapshot for transitions; active destination stays live. Transient texture budget includes both scenes during a transition, masks and snapshots. At max texture DPR2 a360×640 RGBA layer is about3.52MiB; account for tall surfaces, padding and simultaneous layers before allocation. Use one combined static board where possible; no dedicated full-screen texture for each shadow/ripple. Maintain separate text resolution, not a global DPR3 bake for everything.

Use pooled particles from baked leaf/dot/ring textures. No more than 24 live particles globally, including simultaneous effects; celebration12, water6, sand4, putt2. Ring/highlight sprites have their separate caps above. At overflow drop oldest decorative particles; never drop score/penalty/input feedback. Stop ambient behind overlays and while aiming/rolling. If frame cost rises, remove light/title/cloud motion, then halve particles, then disable slope shimmer; keep gameplay, text, contact markers and accessible controls.

Track textures, geometry masks, tweens, timers, input handlers, OS media listeners and particle pools by owning scene. On shutdown cancel callbacks, destroy sprites/masks, release owned texture keys and remove listeners. Shared textures need reference counts and destruction at last release; do not remove a source texture still used by an outgoing snapshot/live scene. No unbounded thumbnail cache across hole visits. Pool visible grid thumbnails; dispose offscreen ones. A scene restart must not reuse a stale `Set` entry for a removed texture.

Builder verification: profile menu idle, rapid transitions, full-power hole 9, water reset, three-star result and ten-hole revisit loop. Capture p95 update/render cost against16.67ms, frame-time distribution, draw calls, live texture bytes and object counts; repeat on a real target phone. After shutdown counts return to the same steady-state baseline, with no monotonic growth. Reduce art cost before changing simulation rate.

## Screenshot review checklist

Use 360×640, 320×568 and 430×932 captures, plus focused gallery crops. Motion needs paired frames; static images do not prove fps or input latency.

- [ ] Warm cream/coral Pocket Park palette; no neon glow or grid survives.
- [ ] Fredoka headings/Nunito body match scale; no text below 13 logical px or fallback font.
- [ ] Gallery shows every shared state, all three pill variants and clear keyboard focus.
- [ ] 56px hit-box overlays remain fixed during press; no targets overlap or fall under safe areas.
- [ ] Panels have visible gradients, rounded corners and uncropped stacked shadows.
- [ ] Hole cards distinguish available/current/completed/locked with text and symbols; stars and locks never overlap.
- [ ] Hole5 and hole 9 debug overlays show art aligned to unchanged collision geometry.
- [ ] Sand/water/slopes/movers are identifiable in grayscale; accessible aim shows dots/dashes/solid and numeric power.
- [ ] Ball, cup, flag and bumper silhouettes remain distinct at phone size; planting clears every playable boundary.
- [ ] Perf/gallery overlay exposes sprite/particle counts and texture budget; actual fps/lifecycle evidence is supplied separately by builders.
