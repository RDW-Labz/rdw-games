# T50 — Holo coworker cards — build contract

**Done when:** the three mutants are killed, the limits are tested, and the cards pass on Braden's Mac (mac-checks row 'T50').

## 0. Findings

**Current card rendering:**
- CoworkerGrid.tsx: 96px portrait images (thumb URL or sprite-sheet background), name, artist, badge ("Ready" / "Not downloaded yet" / "✓ In use"), optional "More motion" tag; radio-button card with role="radio", aria-checked, border highlighting on selection.
- PickCoworkerStep.tsx: reuses CoworkerChoices (same grid).
- Onboarding.tsx: lazy-loads PickCoworkerStep on beat 6.
- Image source: CoworkerImage union type from useCoworkers.ts — either `{ kind: 'thumb', url }` or `{ kind: 'sheet', url, grid? }`.

**Design system available:**
- Lantern tokens in src/design/tokens.ts: light/dark theme pairs, no additional theming.
- Gold: `--oasis-needs-you` (light #7c5010, dark #f4c261) and `--oasis-rim` (light #a06a14, dark #e0a83e); shape vocabulary in primitives.css (lamp, pause-glyph, radius tokens, shadows).
- Border radii: `--oasis-radius-sm` (8px), `--oasis-radius-md` (12px), `--oasis-radius-lg` (16px), `--oasis-radius-pill` (999px).
- Transitions: `--oasis-duration-fast` (120ms), `--oasis-duration-base` (200ms), `--oasis-ease-out`, `--oasis-ease-in`, `--oasis-ease-standard`.

**Testing stack:**
- vitest + jsdom + React Testing Library.
- Tests use `vi.useFakeTimers()` and `vi.stubGlobal()` for URL, matchMedia.
- setup.ts provides `@testing-library/jest-dom/vitest` and WebSocket polyfill (ws).
- Existing tests (Coworkers.test.tsx, Onboarding.test.tsx) cover grid interaction (radio, keyboard nav, pick flow) and state transitions; coworkers.css already tested for reduced-motion.

**ThreeUI technique reference (fetch completed):**
- Foil/iridescence: layered foil effects.
- Border: engraved gold borders.
- Tilt/flip: tactile tilt, rotation, and flip controls via pointer tracking.
- Pointer lighting: pointer-reactive illumination following cursor.
- Animations: drifting embers (splice only, not here), candlelit ambient lighting.
- Stack: Three.js r180 + custom GLSL + embedded models/textures.

**Candidate libraries from research (threejs-shortlist.md):**
- holocloth (MIT), guillocheJS (MIT), vanilla-tilt.js (MIT) noted for reference but not adopted in v1 per decision #159 (no new npm dependencies).

**Provisional picks (decision #159, Braden may amend):**
- **Tilt driver:** custom pointer→rotateX/rotateY math in holoCardState.ts; ±12° on hover, clamped, no tweening.
- **Drag-to-rotate:** v1 includes left-mouse drag rotates Y-axis up to ±180°; release snaps back to 0° unless card is flipped.
- **Foil layer:** CSS-only (layered linear + conic gradients, `--glare-x/--glare-y` custom properties driven by pointer). Sparkle: ONE 2D canvas rendered once at holoCardState module load (data-URL, ~50KB, reused per page, no per-frame work).
- **Border:** CSS engraved gold (inset box-shadows, 2–3 layers, using `--oasis-needs-you` and `--oasis-rim` tokens).
- **IntersectionObserver threshold:** 0.25 (25% of card in viewport).
- **Three.js amendment path:** if Braden prefers 3D fidelity (holocloth shader or particle effects), exact version pinned in package.json (e.g., `three@0.180.0`, not `^` or `latest`), listed as an outside dependency needing #112 approval; not built in v1.

**No WebGL/canvas in current main bundle:**
- orb/avatarEngine.ts uses canvas for sprite frame rendering (isolated, on-demand, T31-owned, untouched).
- No global canvas or Three.js code exists in src/ or styles/.
- One shared renderer per page is required IF any canvas used; not needed for CSS-only.

**Motion and visibility:**
- `prefers-reduced-motion: reduce` already handled in design/tokens.ts and base.css (durations → 0, breath → off).
- `document.visibilityState` used in ChatRail.tsx to stop animations when window hidden (extend for card).
- IntersectionObserver not currently used in main; useCoworkers.ts may have scroll-based lazy loading (check useCoworkers implementation if pagination exists).
- Idle CPU rule documented in docs/idle-budget.md: RAM under 30MB, CPU under 1% at idle. No polling, no timers, no animation while invisible or hovered-off.

**CI jobs:**
- `npm lint` (eslint).
- `npm test` (vitest run, jsdom).
- `npm run typecheck` (tsc).
- `npm run build` (vite build).
- `npm run tauri build -- --no-bundle` (Rust checks + web build).
- `cargo fmt`, `cargo clippy`, `cargo test` (Rust).
- No screenshot job yet (decision #293 requires one for UI design questions; Braden merges final pick).

## 1. Jobs

Two independent writers, no file overlap, parallel-safe.

### Job `t50-card` (HoloCard component and state logic)

**Files:**
- `src/components/HoloCard.tsx` (new, ~140–180 lines): React component managing flip state, visibility gating, portrait image fallback, reduced-motion detection. Calls useHoloCardState for pointer tracking.
  - Props: `portrait: CoworkerImage | undefined`, `name: string`, `category: string | null`, `moreMotion: boolean`, `onPick: () => void`, `visible: boolean` (parent tracks via IntersectionObserver), `reduced: boolean` (from `prefers-reduced-motion`).
  - Renders: front face (portrait + foil layer + gold border), back face (name, category, "More motion" tag if moreMotion=true, "Pick" button), CSS 3D flip container. Applies data attributes from useHoloCardState (hovered, visible, reduced, flipped).
  - Static PNG fallback: when `!visible || !hovered`, render portrait only as <img> with class `holo-card__fallback` (no 3D, no animation).
  - Keyboard: Enter/Space toggles flip, Tab reaches Pick button.
  - ARIA: `role="article"`, `aria-label="<name> card, press Space to flip"`, Pick button `aria-label="Pick <name>"`.

- `src/components/holoCard.css` (new, ~200 lines): 
  - 3D perspective, preserve-3d, transform-style.
  - Front/back faces (backface-visibility: hidden, rotateY for flip).
  - Foil layer: linear + conic gradients, CSS custom properties `--glare-x` and `--glare-y` (0–100, pointer-driven), opacity animation.
  - Gold border: 2–3 inset box-shadows with `--oasis-needs-you` and `--oasis-rim`, engraved look.
  - Tilt: transform-origin and rotateX/rotateY from CSS vars (pointer math in holoCardState), clamped ±12° on hover, ±180° drag. Reset on leave if not flipped.
  - Flip animation: 400–600ms transition, easing from tokens.
  - Reduced-motion: no transition, instant flip, no tilt/glare.
  - Data attributes: `[data-hovered]`, `[data-visible]`, `[data-reduced]`, `[data-flipped]`.

- `src/lib/holoCardState.ts` (new, ~140 lines): pure module, no React, no external dependencies.
  - `useHoloCardState(element: HTMLElement | null, visible: boolean, reduced: boolean) => { flipped: boolean, hovered: boolean, tiltX: number, tiltY: number, dragRotY: number, toggleFlip: () => void }`.
  - Tracks IntersectionObserver (visible), matchMedia `prefers-reduced-motion` (reduced), pointer events (enter/move/down/up, left-button drag for Y rotation), visibilitychange (page hidden).
  - Pointer move: `(x - cardCenter.x) / cardWidth` clamped to ±12° rotateX, `(y - cardCenter.y) / cardHeight` clamped to ±12° rotateY; custom CSS properties `--tilt-x`, `--tilt-y` (degrees), `--glare-x`, `--glare-y` (0–100 for gradient stops).
  - Drag (left button): `(pointermove.x - pointerdown.x) / cardWidth * 180` for additional Y rotation (up to ±180°); release snaps back to 0° if not flipped, else stays at 180°.
  - Animation gates: render tilt/glare only if visible AND hovered AND !reduced; else zero CSS vars, static PNG. Flip persists across visibility/hover changes.
  - Sparkle: at module load, create one 2D canvas (64×64), render procedural sparkle (tiny circles, glitter pattern), convert to data-URL, reuse per page via CSS background-image.

- `tests/holoCard.test.tsx` (new, ~200–280 lines): vitest + jsdom + RTL.
  - Mock `IntersectionObserver` (vi.stubGlobal), `matchMedia`, `requestAnimationFrame` (jsdom default).
  - Test 1: card renders front face at rest (portrait, name, badge, "More motion" tag if present).
  - Test 2: back face shows on Space/Enter key or click on flip button.
  - Test 3: back face hides on Space/Enter again (double flip).
  - Test 4: static PNG rendered when visible=false (no tilt, no animation).
  - Test 5: static PNG when hovered=false (no animation active, but flip state persists).
  - Test 6: reduced-motion media query: no transition, instant flip, no glare/tilt classes.
  - Test 7: keyboard focus shows same visual as hover (outline, glare if visible + hovered).
  - Test 8: "Pick" button is a real <button> with onClick, not preventDefault'd by card.

- `tests/holoCardState.test.ts` (new, ~150–200 lines): pure unit tests.
  - Test 1: `useHoloCardState` with visible=true, hovered=true: tilt/glare x,y in expected range, animation enabled.
  - Test 2: visible=true, hovered=false: tilt/glare x,y zeros, no animation.
  - Test 3: visible=false: no animation regardless of hover.
  - Test 4: reduced=true: tilt/glare disabled even if visible+hovered.
  - Test 5: toggleFlip state toggles, persists across visibility changes.
  - Test 6: pointermove updates tilt/glare (mock pointer events on element).
  - Test 7: visibilitychange API (document.hidden) stops animation.
  - Test 8: IntersectionObserver entry.isIntersecting controls visible gate.

**Tests:** Run `npm test -- tests/holoCard.test.tsx tests/holoCardState.test.ts`.

### Job `t50-wire` (Integration into Coworkers page and onboarding)

**Files:**
- `src/components/CoworkerGrid.tsx` (edit, ~10–20 lines added):
  - Wrap each card in `<HoloCard visible={isInViewport} ... />` instead of the current simple card div.
  - Track visibility per card using IntersectionObserver callback or conditional render based on scroll position.
  - Pass `portrait`, `name`, `category`, `moreMotion` props from pack data.
  - `onPick` callback remains unchanged (calls parent's onPick(id)).
  - StatusLine remains below/outside the HoloCard (progress bar, cancel, retry).
  - Remove old `.coworker__card` styles related to tilt/flip (none exist yet; coworkers.css only has static card styles).

- `src/components/PickCoworkerStep.tsx` (edit, minimal, <5 lines):
  - No changes needed; CoworkerChoices → CoworkerGrid already wired.
  - Verify HoloCard renders in onboarding-story container (coworkers.css applies there too).

- `src/styles/coworkers.css` (edit, ~20–30 lines):
  - Remove or override conflicting styles from `.coworker__card` (e.g., fixed height, static image size).
  - Ensure HoloCard container takes same grid space (width: 100%, or inherit from grid cell).
  - Adjust spacing if foil layer + border affects layout (may be slightly larger than 96px image).
  - Ensure StatusLine placement below HoloCard is not affected.
  - Preserve `.coworkers__grid` grid-template-columns and gap for both pages.

- `CHANGELOG.md` (edit, 1 line at top of `## Unreleased`):
  - `T50: Holo coworker cards with tilt, flip, and static fallback on Coworkers page and onboarding pick step (#232).`
  - (Note: shared CHANGELOG with main branch; rebase expected per rules §2.)

- `docs/DESIGN.md` or `docs/UI.md` (edit or create, if exists, ~15–20 lines):
  - If a UI doc exists (check repo), add one section: "HoloCard (T50): 3D tilt and flip on hover, static PNG fallback when invisible or not hovered, reduced-motion disables animation."
  - If no doc, skip (not required).

- `tests/holoCardWire.test.tsx` (new, ~120–160 lines): integration tests.
  - Test 1: CoworkerGrid renders HoloCard for each pack (check for HoloCard component in DOM or data-testid).
  - Test 2: Clicking "Pick" on HoloCard calls parent's onPick (event flows out).
  - Test 3: IntersectionObserver fires; visible card renders animation-capable state, off-screen card renders static PNG.
  - Test 4: PickCoworkerStep renders CoworkerChoices → CoworkerGrid with HoloCards (integration, no service needed, fake coworkers).
  - Test 5: StatusLine (progress, cancel, retry) renders below HoloCard without interference.

- **Edits to existing tests** (Coworkers.test.tsx, Onboarding.test.tsx):
  - Mock IntersectionObserver in setup.ts or per-test so cards initialize correctly.
  - Existing radio-button tests should still pass (HoloCard exports the same radio element or wraps it without changing role/aria-checked).
  - Verify "Pick" flow unchanged (onPick callback still fires).
  - Run full test suite: `npm test`.

**Tests:** Run `npm test -- tests/holoCardWire.test.tsx tests/Coworkers.test.tsx tests/Onboarding.test.tsx`.

## 2. Rules

**HoloCard design and interaction:**
- **Front face:** portrait image (CoworkerImage) centered, foil layer (linear + conic CSS gradients + sparkle from 2D canvas data-URL), engraved gold border (box-shadow layers, Lantern `--oasis-needs-you` + `--oasis-rim`). No new image assets.
- **Back face:** centered name (bold), category (smaller, muted if non-null), "More motion" tag (pill, muted, if moreMotion=true), "Pick" button (<button>).
- **Interaction:**
  - Hover: pointer move tilts ±12° X/Y (custom math in holoCardState, no tweening). Glare highlight (radial gradient, CSS custom properties). Drag (left-button, primary) rotates Y-axis ±180° additional; release snaps back to 0° unless flipped.
  - Click/Space/Enter: toggles flip; instant under reduced-motion.
  - Focus: keyboard focus shows hover visual (outline, glare if visible+hovered).
- **Static fallback:** when `!visible || !hovered`, render portrait as <img class="holo-card__fallback"> (no 3D, no animation). Flip state persists.
- **Idle CPU rule:** tilt/glare/sparkle animate only while visible AND hovered AND !reduced. Stop on document.hidden, IntersectionObserver threshold crossed, pointer leave, or reduced-motion. No loops.
- **Reduced motion:** no tilt angle, no glare, no sparkle animation, flip instant (transition: none). Flip/Pick still work.
- **No assets >2 MB:** portrait image ≤2MB. Sparkle generated once at module load as data-URL (~50KB, embedded, no external file).
- **No company data, no model calls:** card renders static image + fixed shape. No API calls.
- **Keyboard and ARIA:**
  - Tab: one stop per HoloCard, reaches Pick.
  - Enter/Space: flip.
  - Pick: real <button>, visible on back face.
  - `aria-label="<name> card, press Space to flip"` (card container), `aria-label="Pick <name>"` (button).
- **Both pages:** Coworkers page + onboarding pick step (beat 6) use same HoloCard component, same holoCard.css, no variants.

## 3. Cross-job names (shared between jobs)

| Name | Type | Used by |
|---|---|---|
| `HoloCard` | React component | t50-card exports; t50-wire imports |
| `holoCard` | CSS module | t50-card writes; t50-wire includes in coworkers.css or separate import |
| `useHoloCardState` | exported function | t50-card writes holoCardState.ts; HoloCard.tsx uses it |
| `.holo-card`, `.holo-card__front`, `.holo-card__back`, `.holo-card__fallback`, `.holo-card__foil`, `.holo-card__glare` | CSS classes | holoCard.css, rendered by HoloCard |
| `[data-hovered]`, `[data-visible]`, `[data-reduced]`, `[data-flipped]` | CSS data attributes | holoCard.css driven by holoCardState, HoloCard renders |
| `portrait`, `name`, `category`, `moreMotion`, `onPick`, `visible`, `reduced` | HoloCard props | CoworkerGrid passes (t50-wire) |
| `flipped`, `hovered`, `tiltX`, `tiltY`, `dragRotY`, `toggleFlip` | holoCardState return | HoloCard uses to drive data attributes |

## 4. Mutants (each must fail a named test)

| Mutant | Test that fails | Reason |
|---|---|---|
| **Card renders while page is hidden** | `holoCardState.test.ts` / Test 7 (visibilitychange API) | visibilitychange listener not implemented; card animates even when `document.hidden === true`. |
| **Back face shows before user flips** | `holoCard.test.tsx` / Test 2 (flip on Space) | default state is flipped=true or flip logic inverted; back face visible at render. |
| **Static fallback missing (hover gating removed)** | `holoCard.test.tsx` / Test 5 (static PNG when hovered=false) and `holoCardWire.test.tsx` / Test 3 (IntersectionObserver gate) | no conditional render when visible=false or hovered=false; card renders animation-capable DOM and CSS transforms even when static should be shown. |

## 5. Checks

**Exact commands from package.json scripts:**

```
npm run lint
npm test
npm run typecheck
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run tauri build -- --no-bundle
```

**Screenshots (decision #293):**

After `npm run build` succeeds, use Playwright (~/.project-swarm/toolchains) to render four states of HoloCard on the Coworkers page or onboarding:
- **A: Rest (no hover).** Card shows front face, portrait, no tilt, no glare, static appearance.
- **B: Hover-tilt.** Card shows front face tilted on pointer move, glare highlight visible, foil sparkle (if animated).
- **C: Flipped.** Card shows back face (name, category, More motion tag, Pick button), same tilt/glare if hovered.
- **D: Reduced-motion.** Card shows front face, no tilt angle on pointer move, no glare, instant flip on Space (no transition animation).

One PNG per state (A-holo-card-rest-light.png, A-holo-card-rest-dark.png, …, D-holo-card-reduced-dark.png). Save in `coordination/references/t50-screenshots/` with filenames like `A-holo-card-rest-light.png`. Screenshots must show the real rendered CSS/components, Braden's light and dark themes, native or 2x size (label each state A–D in the filename or as an overlay). Post to Braden before merge so he can approve the look (visual quality, alignment, colors, animation smoothness in video if available).

## Open (provisional picks, each Braden may amend)

1. **Tilt driver:** v1 uses custom pointer→rotateX/rotateY math (no npm dep, ±12° hover clamp, zero-crossing snap). Braden may amend to: Three.js with exact version pinned (e.g., `three@0.180.0`), custom GLSL foil+sparkle, requires #112 approval, idle/bundle impact measured.

2. **Drag-to-rotate:** v1 includes left-mouse drag Y-axis ±180° (snaps back if not flipped). Braden may amend to: remove drag in favor of Space/Enter flip only, or extend to ±360° continuous drag.

3. **Foil layer:** v1 is CSS-only (linear + conic gradients, glare-x/glare-y custom properties, sparkle from 2D canvas data-URL at load). Braden may amend to: procedural shader (holocloth), baked texture, or omit foil (plain background).

4. **Gold border:** v1 is CSS engraved (box-shadow inset layers, Lantern gold tokens). Braden may amend to: guillocheJS guilloche texture, SVG path, or flat border.

5. **IntersectionObserver threshold:** v1 uses 0.25 (25% in viewport). Braden may amend to: 0 (any pixel), 0.5 (half), or 1.0 (fully visible).

## CHANGELOG note

**CHANGELOG.md edit:** One line at the top of `## Unreleased`:
```
T50: Holo coworker cards with tilt, flip, and static fallback on Coworkers page and onboarding pick step (#232).
```

**Rebase expected:** CHANGELOG is shared across branches; main may have other entries when this PR lands. Rebase and resolve conflicts by keeping all entries in reverse chronological order.
