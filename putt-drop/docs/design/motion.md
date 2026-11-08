# Pocket Park motion specification

Status: builder contract, 2026-10-12. Read with [system](system.md) and [screens](screens.md). This replaces the study's slower sheet/reward timings and the existing two-part scene fade. Motion gives the park weight and life while actions remain immediate. All dimensions/timing/amplitudes below become named `TOKENS.motion` entries in `src/ui/tokens.ts`; no copied constants inside scenes.

## 1. Timing, easing and input

| `motion.duration` key | Milliseconds | Use |
|---|---|---|
| `instant` | 80 | Press depression, contact cue, reduced-motion fade |
| `quick` | 160 | Release, small appear/exit, toggle, sheet exit |
| `base` | 240 | Entire screen change, sheet entrance, card entrance |
| `slow` | 400 | Nonblocking decorative reward/flag settle only |
| `ambientMin`, `ambientMax` | 3000, 8000 | Gentle menu cycles; per-effect periods below |
| `stagger` | 24 | Visible button/card start offsets; cap total delay at 72 |
| `contactIn`, `contactOut` | 48, 112 | Visual impact compression/recovery |
| `toastHold`, `hintDelay`, `hintCycle` | 4000, 1800, 2400 | Readable message duration and tutorial timing |

`motion.ease = { press:'Cubic.easeOut', release:'Cubic.easeOut', enter:'Cubic.easeOut', exit:'Cubic.easeIn', ambient:'Sine.easeInOut', drift:'Linear', drop:'Cubic.easeIn', pop:'Back.easeOut', fade:'Linear' }`. These names match the installed Phaser4 easing map. `Back.easeOut` is used only for reward stars; pass `easeParams:[0.6]` and clamp visible scale to 1.04. No elastic overshoot of text, controls, collision outlines or camera. Mechanical movement keeps simulation easing; never substitute a visual tween.

Pointer-down produces a visible press cue in the next rendered frame and a light UI sound if enabled. Pointer-up inside the unchanged hit rectangle executes synchronously and exactly once. Pointer-out/cancel, app hide or a drag exceeding8 logical px clears capture and cannot accidentally click a scrolled card. Navigation does not wait for release/exit/appear tweens. Show destination controls with readable labels and final hit areas from the first frame. Decorative faces can ease into place; pressing an entering face snaps it and acts. No global `isAnimating` input lock.

Only logical state restricts input: disabled unavailable operation, modal ownership, store request already outstanding, or a ball actually in flight. Modals receive input immediately; their scrim stops accidental strokes underneath from the first frame. A screen change discards old pointer capture so the same release cannot activate a newly exposed button. A fresh tap is accepted during every transition. Dedupe accepted navigation/purchase/reset operations by operation ID, not an animation timer.

Cancellation rule: each effect has an owner plus target/property key. Retarget from its current value; never stack multiple tweens writing the same property. On scene shutdown remove owned tweens/timers/listeners and suppress late audio/completion callbacks. When a new screen request arrives during a pan, settle the current decoration and begin the new request immediately; do not queue pans. No camera shake anywhere in Pocket Park, including legacy `shake:true` saves.

## 2. Park map and travel

Conceptual map, not a world coordinate map for golf physics. Store in `motion.parkMap` with `{x,y}` in park-cell units; positive x=east, positive y=south.

| Screen/place | Map coordinate | Relationship |
|---|---|---|
| Boot / Menu, park entrance | (0,0) | Boot resolves in place |
| Hole select, noticeboard | (1,0) | East of entrance |
| Settings, garden bench | (0,−1) | North of entrance |
| Play / result, putting lawn | (1,1) | South of noticeboard |
| Unlock / success / restore result, pavilion | (2,1) | East of lawn |
| Pause/reset/hint/toast | Host coordinate | Overlay, no park travel |
| Dev gallery, workshop | (−1,0) | Development only |

For any navigation A→B, camera travel direction is normalized `(B−A)`; reverse navigation reverses it. Menu→Play goes southeast, Menu→Holes east, Holes→Play south, Menu→Settings north, Play→Unlock east. Unlock→free Holes is northwest. Restore/success stay in the pavilion; if Restore was invoked elsewhere use its invoking host coordinate. Settings from Pause travels northwest to the bench; Done returns southeast to the frozen lawn and reopens Pause. Result→next hole travels east along the lawn by a virtual cell; result→retry crossfades in place. Last hole→Holes goes north. Every other route follows coordinate subtraction; overlays never move the course.

**One 240ms transition total**, not240ms out plus 240ms in. Destination becomes the active state immediately. Keep real UI/gameplay at final coordinates. Create one noninteractive outgoing background/board snapshot; move it opposite the travel vector by 24 logical px while fading1→0. Move only the incoming scenery root from +24 along the vector to 0 while fading0.70→1, all `Cubic.easeOut`. Layers: distant cloud/light offset 6 (0.25×), planting offset 12 (0.5×), ground/island24 (1×). The live course is stationary and fully visible once a putt starts; initiating a drag finishes all travel decoration immediately. No moving physics camera, rotated course or coordinate remap during a shot. UI text is never doubled into the snapshot; omit live controls from the outgoing snapshot.

This parallax suggests walking a few steps around the park without a full-width carousel. If the target is not ready, show its usable loading/error shell immediately; do not hold the old scene for an animation. Preload bundled level data and textures before interaction where possible. Reduced motion replaces all directions/parallax with an80ms background crossfade; controls and course appear immediately.

## 3. Complete effect inventory

Durations include all phases unless explicitly marked as a repeating cycle. Counts are upper bounds, not emission rates. Every budget also obeys the global caps in system.md. Effect keys below are the keys of `motion.effect`.

| Name | Purpose | Trigger | Duration/easing and exact treatment | Interruption behaviour | Reduced-motion version | Perf budget |
|---|---|---|---|---|---|---|
| `treeSway` | Gentle living canopy | Menu idle | 6000ms full cycle, Sine.easeInOut; −1.5°→+1.5°→−1.5°, pivot at trunk | Stop behind sheet/on hide; resume from frozen phase; destroy on leave | Static neutral angle | ≤3 canopy sprites/tweens; no Graphics |
| `cloudDrift` | Slow sky depth | Menu idle | 8000ms full cycle, Sine.easeInOut; x −8→+8→−8; no wrap across screen | Freeze on interaction; no re-entry jump | Static | ≤2 sprites, part of 8 ambient cap |
| `lightShift` | Warm light variation | Menu idle | 8000ms full cycle, Sine.easeInOut; baked upper-right patch alpha 0.06→0.12→0.06 | Freeze behind overlays; release on exit | Fixed alpha 0.08 | 1 sprite ≤half screen area |
| `titleBreathing` | Soft title presence | Menu idle | 4000ms full cycle, Sine.easeInOut; alpha 0.94→1→0.94; no font scaling | Stop on pointer-down; restore1 | Static alpha 1 | 1 title container |
| `menuBallFloat` | Toy island detail | Menu idle | 4000ms full cycle, Sine.easeInOut; y0→−3→0, angle 0→1°→0; shadow anchored | Stop when Play pressed | Static at rest | 1 ball sprite; total ambient max 8 |
| `buttonPress` | Instant tactile contact | Pointer-down, all actionable button/card faces | 80ms Cubic.easeOut; immediate tint at alpha 0.02; background scale 0.97, y+2, label y+2 only | New input retargets; cancel removes cue without action | Immediate tint only; no transform | 1 face tween + label y, ≤1 captured control |
| `buttonRelease` | Settle under thumb | Valid up or cancel | 160ms Cubic.easeOut to scale 1/y0; action executes at start | Navigation kills tween; never delays handler | 80ms tint fade | ≤2 property targets |
| `controlAppear` | Buttons arrive gently | Screen/child mount | 160ms Cubic.easeOut; face y+6→0, alpha 0.70→1; stagger24ms, cap 72 | Tap snaps face; labels/hit areas already ready | All at final position;80ms face fade, no stagger | ≤4 visible controls staggered |
| `cardAppear` | Noticeboard/result weight | Card mount / newly visible row | 160ms Cubic.easeOut; face y+8→0, alpha 0.70→1; stagger24/cap 72 | Scroll/tap settles affected cards; no animation replay when scrolling back | 80ms fade, no translation/stagger | ≤6 visible cards; ≤232ms including delays |
| `controlExit` | Clear old decoration | Control removal | 80ms Linear alpha→0 on inert visual | Unregister immediately; destroy if next owner needs budget | 80ms fade or immediate removal | Reuse existing visual, no new texture |
| `parkTravel` | Move between park places | Navigation | 240ms Cubic.easeOut, vector/parallax recipe above | Latest accepted route wins; drag finishes motion now | 80ms crossfade; no pan/parallax | 1 outgoing snapshot, ≤3 incoming scenery roots |
| `sheetIn` | Bring a panel into reach | Pause/reset/result/restore open | 240ms Cubic.easeOut; panel face y+16→0, alpha 0.75→1; scrim0→0.32 in 80ms | Close acts immediately; controls stay at final coordinates; no scale bounce | 80ms opacity only | 1 face,1 scrim; child controls use no extra entrance |
| `sheetOut` | Return to park | Dismiss/back/resume | 160ms Cubic.easeIn face y0→+12 and alpha→0; scrim80ms | Modal logical ownership ends now; old pointer release consumed; remaining clone inert | 80ms fade | Same face/scrim; no additional capture |
| `toggleSlide` | Show chosen setting | Accepted toggle tap | State/text changes now; knob24px in 160ms Cubic.easeOut; track crossfade80ms | Rapid toggles retarget; one save of latest state | Knob snaps;80ms color fade; On/Off label immediate | 1 knob + pre-baked on/off track |
| `aimAcquire` | Teach contact and direction | Resting-ball drag begins | Ring radius 20 fades in 80ms; line/power numeric update on current input, no lag | Cancel hides immediately; pointer-up launches now | Same static ring/line/meter | ≤64 pooled aim marks;1 ring; no particles |
| `puttRelease` | Physical launch response | Valid released shot | Simulation starts now; guide fades80ms; ball decorative compression0.97 for 48 then1 over112ms | First collision supersedes squash; next drag clears guide | Guide off immediately; no squash/flecks | ≤2 turf flecks, life 160ms; no trail |
| `ballRoll` | Read motion on ceramic ball | Simulation displacement | Seam angle integrates traveled distance/r; shadow tracks ball with no lag | Stop at rest/pause; never extrapolate after sim stops | Ball translation remains; fixed seam/shading | Ball+seam+shadow, no redraw |
| `ballWallSquash` | Contact weight | `wall-hit`, true contact normal | 48ms Cubic.easeOut: normal scale 0.94/tangent1.03;112ms return; fixed center | Latest contact replaces; never accumulate deformation | 80ms fixed contact highlight only | 1 ball visual; collision radius unchanged |
| `railHit` | Local rail flex/highlight | `wall-hit` with contact segment | 48ms highlight moves1px outward/alpha 0.5;112ms return/fade; core fixed | Same segment cooldown80ms; newest2 contacts retained | Fixed highlight80ms, no flex | ≤2 pooled24-unit caps; no board rebake |
| `bumperBoing` | Rubber spring reaction | `bumper-hit` with object ID | Crown scale 0.92 for 48ms then1.04 at 160ms then1 at 240ms; Cubic.easeOut segments | Retarget crown from current scale; rim fixed | Fixed crown highlight80ms; contact sound allowed | 1 crown tween per hit; max 2 active |
| `waterReset` | Explain penalty/reset | `water` at captured entry point | At0: penalty +1 once, sim already at shot origin. Entry clone fades80ms. Two rings radius 6→24 over400ms Cubic.easeOut;6 droplets life 240ms. Live reset ball visible immediately, alpha 0.65→1 in 80ms | New aim cancels ghost/droplets and snaps reset ball1; reset never waits for splash | No rings/droplets/ghost travel; live ball opaque at origin immediately; static “Water · +1 penalty” | 2 rings,6 droplets,1 temporary ball clone;1 HUD message |
| `sandPuff` | Show soft friction change | `sand-enter`, not every frame inside | 240ms Cubic.easeOut;4 dots move≤10px/fade; radius 1.5→2.5 | Same shot/zone cooldown160ms; exit does not retrigger | Fixed small sand contact mark80ms | ≤4 pooled dots; no sand redraw |
| `slopeShimmer` | Reinforce actual force direction | First ball entry to a slope this shot | 400ms Sine.easeInOut, duplicate baked arrow patch alpha 0→0.12→0; no traveling stripes | Fade out on exit/aim/pause; once per slope per shot | Static arrows only | 1 masked overlay patch; baked mask |
| `moverTravel` | Show real moving obstacle | Every simulation step while active | Position/orientation exactly from sim; period from level, typically2500–5000ms; no visual easing layer | Freeze with simulation on pause; resume same clock; no extra wall-clock advancement at rest | Same essential movement; disable decorative highlight shimmer | 1 body+shadow per mover; static track |
| `rimRattle` | Distinguish near miss | `rim` or `lip-out` | Lip highlight alpha 0.6→0 in 160ms; pole stays still; short rim sound | Debounce same cup120ms; successful drop cancels | Fixed lip highlight80ms; no shake | 1 lip overlay, no confetti |
| `ballDrop` | Ball falls into depth | Authoritative `holed` only | 160ms Cubic.easeIn; clone sinks y+4, scale 1→0.2 and alpha 1→0 under cup lip; shadow scale 1→0.5 | Next/Retry/Holes cancels clone immediately; score already committed | Hide real ball immediately; cup lip80ms fade | 1 clone, existing lip/mask; no physics tween |
| `flagWiggle` | Cup answers success | `holed`, offset 160ms after drop start | 400ms segmented Sine.easeInOut; cloth0→+3° at 80,→−2° at 200,→0 at 400 | Leaving cancels; fixed pole; no re-trigger from rim | Static cloth | 1 cloth sprite |
| `holeReward` | Earned joyful finish | `holed` once per attempt | Sequence below; ≤800ms decorative finish; leaf travel max 40px; no full-screen flash | Any Next/Retry/Holes action skips all remaining visuals/sounds immediately | All result values/buttons immediate;80ms face fade; one quiet completion note, no particles/pop | 12 leaf/confetti sprites globally; ≤24 total particles |
| `starPop` | Count earned stars | Reward timeline at 240/320/400ms | Each160ms Back.easeOut param0.6, scale 0.86→1 max 1.04; one tuned note per earned star | Skip missing stars; navigation cancels queued notes; never repeats on return | No scale/stagger; stars final immediately; no staggered notes | 3 static base stars + ≤1 active accent overlay per star |
| `strokeReveal` | Reinforce factual result | Reward at 480ms | 80ms Linear underline alpha 0→1→0; number present from F0, no count-up | Navigation removes accent; actual value never hidden | Static actual strokes/par | 1 baked underline, no changing Text per frame |
| `bestBadge` | Recognize real improvement | Reward at 560ms if prior best exists and this score is lower | 160ms Cubic.easeOut face alpha 0.7→1; badge text visible F0 | No badge on tie; cancel if leaving | Static badge | 1 chip, no emitter |
| `ghostHand` | Show drag back without reading | First eligible hole, idle1800ms | 2400ms cycle: fade80, hold160, drag48px opposite safe aim direction over640 Cubic.easeInOut, release80, rest1440; max 2 cycles | Any valid play-area touch cancels immediately; on valid first putt persist seen; no fake shot or score | Static hand + dotted arrow and “Drag back, release to putt”; no auto motion | 1 hand texture,1 dotted path; no gameplay input capture |
| `unlockAppear` | Honest pavilion offer | Enter Unlock | parkTravel total 240ms; feature card uses160ms fade within same window, CTA ready at 0 | Buy/Restore/free replay acts immediately; request dedupe independent of motion | 80ms fade, no stagger | 1 feature card; no price pulse or countdown |
| `unlockSuccess` | Confirm verified entitlement | Store confirms/restores purchase |240ms card face settle using cardAppear;6 leaves ≤400ms, Done ready at 0 | Acknowledge exits now; no repeated charge/navigation |80ms fade, check icon static |6 particles, within global24; no celebration loop |
| `restoreResult` | Clear recovery outcome | Restore completes |160ms face fade at fixed position; all text/actions immediately present |Dismiss cancels decoration; late result updates store state safely, never reopens stale scene |80ms fade |1 sheet, no particles |
| `toast` | Explain nonblocking outcome | Save/store feedback |160ms face fade with y+4→0; content visible now; hold4000ms then160ms exit; errors with Retry stay until resolved/dismissed | One visible; duplicate text coalesces; error outranks info; replace without stacking over CTA |80ms fade, no translation; same readable lifetime |1 toast root, no screen shake |
| `bootResolve` | Warm first paint | Bundled fonts/levels ready |80ms Linear mark fade, Menu controls available immediately | Failure switches to error shell; no spinner deadline animation gate |Same80ms fade |1 baked mark and ≤3 progress dots |

Ambient cycle durations above are full out-and-back cycles; when using Phaser `yoyo`, each leg is half the listed period. Pause them while the page is hidden and do not replay missed cycles on visibility return.

## 4. Hole-complete reward storyboard (60fps reference)

Time0 is `holed`, not pointer release. Frames describe visual checkpoints at 60Hz; schedule using elapsed milliseconds, never frame counts. Score, best, stars and the next route are calculated once at 0, then saved asynchronously. No reward callback changes a score or grants entitlement. Save failure produces its own toast and leaves the honest in-memory result usable.

| Frames / time | Visible reward | Input/audio contract |
|---|---|---|
| F0 /0ms | Real ball stops; masked drop clone starts. Result text/strokes/par/earned star fills and **Next hole** already readable at final positions; sheet face starts at alpha 0.75/y+16. Cup remains visible above sheet if its real position permits. | Next/Retry/Holes enabled immediately. Completion sound begins only if sound enabled. Never duplicate the source ball to fake a second drop. |
| F1–5 /17–83ms | Ball descends inside cup lip, shadow contracts. Sheet face/scrim rise/fade. | Controls snap face if tapped; move on immediately. No tutorial-like wait. |
| F6–9 /100–150ms | Ball disappears under lip; twelve tiny coral/gold/green leaves launch near cup, stay within 40px, life≤640ms. | Quiet cup plop; optional single light haptic if vibration enabled. No camera movement. |
| F10–14 /167–233ms | Drop is complete, flag cloth starts wiggle; sheet finishes settling by 240ms. | Stop residual hole sounds; duck music to 0.65 for at most800ms, restore on exit. |
| F15–18 /250–300ms | First earned star accent pops (starts 240ms); base stars were already truthful. | Note C5 for first earned star, duration 80ms, gain 0.12. |
| F19–23 /317–383ms | Second earned star accent starts 320ms if earned. | Note E5,80ms/gain 0.12. Sound off means silence, never delayed playback. |
| F24–28 /400–467ms | Third earned star accent starts 400ms if earned. Unearned stars stay empty. | Note G5,80ms/gain 0.12. No unearned star sound. |
| F29–33 /483–550ms | Actual stroke count receives a brief underline; no counting through false scores. | No additional input constraint or sound. |
| F34–42 /567–700ms | “Personal best” badge face brightens only for a strict improvement over a recorded previous best. First completion says “First finish”; tie says “Best N”. | All result text was available from 0; late queued audio is cancelled on exit. |
| F43–48 /717–800ms | Last leaves fade; result rests. Next stays the only primary action. | Never start a second reward loop. |

For hole 12 without entitlement, Next reads **Continue** and routes to Unlock. For an unlocked user it reads **Next hole** only when hole 13 actually exists. Final bundled hole uses **Back to holes**. Do not auto-open a paywall during celebration or trap the player until star sounds finish. If the cup lies behind the result, leave it at its real coordinate; the sheet may occlude the drop. Do not move the cup/ball or reposition the entire course for this animation.

## 5. Reduced motion, accessibility and lifecycle

Effective policy is `reduceMotion = saved.settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches`. Missing saved preference defaults false; the OS still wins. Settings shows stored preference and, when applicable, “Reduced by device setting”. Turning the game toggle off cannot override OS reduce. Subscribe to OS changes while active; unsubscribe on shutdown. Read effective policy before creating any idle tween.

On change to reduced motion mid-effect, kill transform/scale/rotation/particle tweens now, snap controls to final position, remove decorative particles and preserve actual simulation position and input capture. Existing screen travel settles immediately, optionally finishing an80ms opacity fade. Do not wait for current motion to end. Never hide a live reset ball until a fade completes.

What remains: ≤80ms UI opacity fades/crossfades; static selected/focus/pressed feedback; immediate score/penalty changes; real ball translation and mechanically necessary mover motion; static aim pattern, power number, direction arrows; user-driven scroll with no added inertial overshoot. What disappears: parallax, camera shake, ambient sway/drift/light breathing, ball seam rotation, squash, rail flex, bumper scaling, ripple expansion, particles, ghost-hand travel, flag wiggle, star bounce and stagger. Haptic/sound preferences are independent; reduced motion uses one completion note rather than a staggered star melody.

Pause freezes simulation and all course effects immediately, discards partial aim without a stroke, and clears the timestep accumulator. Resume continues from frozen simulation time, without a catch-up jump. App hide cancels capture, mutes/pauses audio, suspends animation and opens Pause on return from Play. Settings return restores the prior Pause sheet; do not silently restart rolling. UI save/store operations may complete while hidden; their results update data once and display the appropriate state when visible.

## Screenshot/storyboard review checklist

Screenshots verify poses, not responsiveness, event correctness or60fps; builders must also supply frame timing and interaction recordings.

- [ ] Menu t=0/2/4/8s frames show gentle canopy/cloud/light/title variation without moving targets.
- [ ] Down/up/cancel frames show small depression with rigid text; hit-box overlay stays unchanged.
- [ ] Transition t=0/120/240ms frames match park directions; all destinations are settled by 240ms.
- [ ] Reduced-motion captures at the same timestamps show no positional/parallax changes.
- [ ] Contact frames show subtle ball squash, local rail highlight and rubber crown response with fixed collision outlines.
- [ ] Water storyboard shows splash at entry, ball at shot origin immediately and exactly one “+1 penalty”.
- [ ] Rim/lip-out frames retain the ball and no reward; holed frames hide it under the cup lip and wiggle the flag.
- [ ] Reward F0 includes real scores and Next; F15/F24/F43 show only earned star accents and bounded leaves.
- [ ] First-time hint, unlock, success, restore and toast poses match this table without animated price pressure.
- [ ] Dev overlay shows particle/sprite/tween caps; separate recordings prove rapid taps, cancellation, OS setting changes and lifecycle cleanup.
