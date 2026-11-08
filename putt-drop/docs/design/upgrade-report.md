# Putt Drop UI/UX, art direction and motion upgrade: handoff (2026-10-13)

Branch: test/pd-int (not merged to main). Direction: Pocket Park (owner's pick). Before/after: docs/design/after/before-after-iphone15.png.

## Criteria

| Criterion | Result | Evidence |
|---|---|---|
| Brief + baseline before building | PASS | docs/design/brief.md, docs/design/baseline/ (45 screens, perf.json) |
| 3 directions, owner picks | PASS | docs/design/directions.md, design/directions/ (owner picked Pocket Park) |
| Design system: tokens + all components + states + dev gallery | PASS | docs/design/system.md, motion.md, screens.md; src/ui/tokens.ts; GalleryScene (test build only) |
| Every screen/state in the brief exists (incl. first-time hint, unlock default/purchasing/success/failed, restore, reduced motion, colorblind aim, reset confirm) | PASS | test-results/screens (21 states x iPhone 15, iPhone SE, Pixel 7), reviewed by orchestrator |
| Honest unlock (what you get, store price, restore, keep playing, no dark patterns) | PASS | unlock-default capture: "Keep playing free holes" primary, unlock disabled "Not on sale yet" until billing exists |
| Alive: menu idle motion, press/appear on every button/card, park travel transitions, physical reactions, celebration | PASS (screens + captures); feel NOT verified on a real phone | course captures (squash, splash, sand puff, cup drop, flag wiggle, celebration), smoke reduced-motion timing |
| Reduced motion (in-game toggle + OS setting) | PASS | smoke reduced-motion run (transitions < 200 ms), celebration-reduced capture |
| Unit tests | PASS | 105/105 |
| Solver (check-levels) | PASS | 12/12 holes, ~28 s |
| Strict real-touch taps, 5 points per control, 3 devices | PASS | 215/215 on iPhone 15 + iPhone SE (WebKit) + Pixel 7 (Chromium), smoke 3/3 runs |
| Picture checks (fills/contrast/toggles), screen-fit/safe areas | PASS | smoke-picture + fit checks in smoke |
| Course/sim alignment at R = 1, 2, 2.625, 3 | PASS | scripts/course-check.mjs |
| No test-only code in the production bundle | PASS | npm run build -> check-bundle: ok |
| 60 fps putt / transition / result at CPU x4 | PASS on desktop GPU (Apple M4, Metal); NOT RUN on a real phone | putt 61.9 avg / 54.3 p5; transition 64.3 / 55.6; result 60.2 / 55.9 |
| Menu interactive < 2 s | PASS | 417 ms (cold, median) |
| No memory growth over 10 holes | PASS | +0.53 MB (10 holes), flat to 30 holes; textures 34 -> 36 (per-hole content, returns per hole) |
| No layout jumps | PASS | layoutJumps 0 |
| JS bundle <= 420 KiB gzip | **FAIL (by 1.2 KiB)** | 421.2 KiB |
| Fonts budget | NOT SET earlier; measured | 436 KB raw / 234 KB gzip (Fredoka + Nunito variable TTF, not subset) |
| Owner phone check on the Wi-Fi link | NOT RUN yet | checklist sent 2026-10-13 |

## Performance before/after (real GPU, Pixel 7 viewport, CPU x4)

| Metric | Baseline as first measured (software GL) | Before, real GPU | After (final) |
|---|---|---|---|
| fps putt avg / p5 | 21 / 8-16 (measurement artifact) | 60.2 / 55 | 61.9 / 54.3 |
| fps transition avg / p5 | 13 / 10 (artifact) | 63 / 52 | 64.3 / 55.6 |
| fps result avg / p5 | 12.6 / 11 (artifact) | 60.5 / 42-56 | 60.2 / 55.9 |
| heap growth over 10 holes | +8-10 MB | +8 MB | +0.5 MB |
| menu interactive | ~350 ms | ~195 ms | ~417 ms |
| JS gzip | 400 KiB | 400 KiB | 421 KiB |

## Not verified
- Real iPhone/Android feel, haptics and audio (desktop GPU and emulated WebKit only).
- Real mid-range phone GPU frame rate.

## Worker notes
Cursor failed 5 UI reviews in this upgrade; 3 jobs were finished by Claude workers (design system after 2 failures;
screens + course under the no-test-weakening rule). See ship-pipeline docs/state/usage-ledger.md.
