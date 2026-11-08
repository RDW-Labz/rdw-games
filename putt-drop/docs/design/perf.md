# Putt Drop performance (pd-perf-10)

Measurement harness: `node scripts/perf.mjs <out.json> [--runs=3] [--profile] [--throttled-only]`  
Environment: Chromium headless, Pixel 7 viewport, `build/web` via `vite preview`, `?test` query.

## Before (baseline)

Source: `docs/design/baseline/perf.json` (CPU ×4). Renderer string was not recorded in baseline.

| Metric | Value |
|--------|------:|
| menuInteractiveMs | 347 |
| fpsPutt avg / p5 | 20.9 / 13.4 |
| fpsMenuTransition avg / p5 | 11.3 / 6.3 |
| fpsResult avg / p5 | 11.6 / 7.7 |
| heap after hole 1 (MB) | 17.74 |
| heap after 10 holes (MB) | 28.30 |
| heap growth 1→10 holes (MB) | **10.57** |
| layoutJumps | 0 |
| JS gzip (KiB) | 400 |

### Before profiling notes (representative issues, confirmed by architecture review)

- `BackgroundGrid` redrew all grid lines and dots via `Graphics.clear()` every frame on every screen.
- Play scene redrew the full course layer (walls, bumpers, cup, ball) every frame in one `Graphics` object.
- Aim preview ran full `simulateShot` on every `pointermove`.
- `generateTexture` level bakes were never removed when switching holes → monotonic texture/heap growth.
- Juice trail/sparks used per-frame `Graphics` fills.

## After (median of 3 runs, post-fix)

Recorded with SwiftShader software GL (see renderer below).

### CPU ×4 (throttled)

| Metric | Before | After | Target | Met? |
|--------|-------:|------:|-------:|:----:|
| menuInteractiveMs | 347 | 525 | ≤600 | yes |
| fpsPutt avg / p5 | 20.9 / 13.4 | 16.9 / 10.7 | ≥55 / ≥45 | no* |
| fpsMenuTransition avg / p5 | 11.3 / 6.3 | 9.2 / 6.8 | ≥50 / ≥40 | no* |
| fpsResult avg / p5 | 11.6 / 7.7 | 9.0 / 6.2 | ≥50 / ≥40 | no* |
| heap growth 1→10 (MB) | 10.57 | **-0.87** | <2 | **yes** |
| heap after 30 holes (MB) | — | 19.41 | plateau | yes |
| textureCount Δ (hole 1→10) | — | **0** | ±2 | **yes** |
| layoutJumps | 0 | 0 | 0 | yes |
| JS gzip (KiB) | 400 | 401 | ≤420 | yes |

### CPU ×1 (unthrottled, same session)

| Metric | Value |
|--------|------:|
| menuInteractiveMs | 326 |
| fpsPutt avg / p5 | 19.1 / 12.1 |
| fpsMenuTransition avg / p5 | 10.4 / 6.3 |
| fpsResult avg / p5 | 5.4 / 3.2 |
| heap growth 1→10 (MB) | 0.68 |
| textureCount Δ | 0 |

\*FPS targets are not reachable in this CI/headless configuration. WebGL renderer:

- **Vendor:** Google Inc. (Google)
- **Renderer:** ANGLE (SwiftShader Device LLVM), i.e. software rasterization.

Profiler self-time during a 2s putt is dominated by `(program)` (~5.4s CPU×4 sample window), with smaller slices in Phaser `batch`, audio `createOscillator`, and input. Unthrottled putt FPS (~19 avg) is in line with baseline (~21), so the remaining gap to 55 FPS is mostly environment/GPU cost, not uncapped JS hot loops. Memory and texture stability targets were the primary regressions in baseline and are fixed.

### Top profiler functions (CPU ×4, first run)

**Putt (2s after shot):** `(program)`, `createOscillator`, Phaser `run`/`batch`, `play` (Web Audio), `vibrate`.

**Menu → Level Select transition (1.2s):** `(program)`, Phaser `batch` (scene build + hole-card textures), `run`, layout/text setup.

## RULES (render architecture for Pocket Park reskin)

1. **Static layers** — Course terrain, walls, sand/water/slopes, resting bumpers, and cup base are baked once per hole into a texture (`bakeLevelStatic`); the image is destroyed on hole change and the texture key is released via `textureCache`.
2. **Ambient motion** — Background grid uses a `TileSprite` and `setTilePosition` only; no per-frame `Graphics` redraw. Prefer tweens on sprites (position/alpha) for ambient motion.
3. **Dynamic layer** — Only movers, pulsing bumpers, cup halo, aim lines, and drag UI go through `Graphics`, and the play overlay skips `clear()` when nothing moved (no drag, ball at rest, no bumper pulse, no aim path).
4. **Ball & juice** — Ball is a tinted `Image`; trail/sparks are pooled `Image` sprites, not `Graphics` circles each frame.
5. **Aim preview** — Recompute only when angle changes by >0.5° or power by >1%, throttled to 30 Hz.
6. **Textures** — Scene-owned keys registered with `acquireSceneTexture`; `releaseSceneTextures` on Play shutdown; global UI keys marked with `markGlobalTexture`. Test hook: `window.__pd.textureCount()`.
7. **Text** — HUD strings updated only in `updateHud` / phase changes, not per frame.
8. **Scenes** — `update()` returns immediately when `!scene.isActive()` so inactive scenes do not animate backgrounds.
9. **Budgets** — Trail pool capped at 12; spark arrays bounded by event handlers; confetti/ring bursts use short-lived sprites with `destroy` on tween complete.

## Causes fixed

| Cause | Fix |
|-------|-----|
| Per-frame grid `Graphics` redraw | `TileSprite` + tile scroll |
| Full course redraw every frame | Bake static layer; pulse/halo only dynamic |
| Ball drawn with `fillEllipse` every frame | `Image` sprite |
| Juice `Graphics` every frame | Pooled sprite pool |
| `simulateShot` every pointermove | Angle/power threshold + 30 Hz throttle |
| Level textures never freed | `textureCache` + release on hole change / shutdown |
| Redundant juice settings work | Cache shake/vibration flags |

## Files changed

- `src/game/textureCache.ts` (new)
- `src/game/render.ts`
- `src/game/PlayScene.ts`
- `src/game/juice.ts`
- `src/game/BootScene.ts`
- `src/game/MenuScene.ts`
- `src/game/LevelSelectScene.ts`
- `src/game/SettingsScene.ts`
- `src/ui/textures.ts`
- `src/main.ts`
- `scripts/perf.mjs`
- `tests/textureCache.test.ts` (new)
- `docs/design/perf.md` (this file)

Raw JSON: `docs/design/perf-runs.json`.

## Orchestrator re-measurement on the real GPU (2026-10-12)

Headless Chromium defaults to SwiftShader (software GL), so the earlier fps numbers measured the CPU rasterizer,
not the game. scripts/perf.mjs now launches with `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`
(PERF_SOFTWARE_GL=1 restores software GL). Renderer: ANGLE Metal, Apple M4. Pixel 7 viewport, CPU x4 throttle,
3 runs each, measured with nothing else running. Raw JSON: docs/design/perf-gpu/.

| metric | before (test/pd-int 0cc1cfe) | after (pd-perf-10) |
|---|---|---|
| fps putt avg / p5 | 60.2-60.3 / 54-56 | 60.1-60.3 / 54-56 |
| fps menu transition avg / p5 | 62.5-63.6 / 50-53 | 63-65 / 52-53 |
| fps result avg / p5 | 60-61 / 42-56 | 53-61 / 35-54 |
| heap growth over 10 holes | +7.9 to +8.5 MB | -0.4 to +0.5 MB |
| heap after 30 holes | 28.1-28.6 MB | 18.2-18.7 MB |
| texture count hole 1 -> 10 | not measurable | 32 -> 32 |
| menu interactive (cold) | 189-199 ms | 235-418 ms |

Conclusions: the 21/13 fps baseline was a measurement artifact; the real defect was memory growth (fixed).
A desktop Apple GPU with CPU x4 is NOT a mid-range phone GPU: real-device fps is unverified until a phone test.
