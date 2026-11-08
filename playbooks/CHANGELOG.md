# Changelog — playbooks

Newest first.

## 0.6.0 — 2026-10-01

- T78 — deterministic r1 still-pack CLI with source-derived 512 px portraits, explicit packaging credits, overwrite refusal, synthetic tests and wheel asset inclusion; real packs and release pin await approval.
- T47 item 5 — CI: new `internal pins` job runs `swarm check-pins` (project-swarm v1.25.0, pinned
  tag) so a stale exact pin on another OASIS package fails CI (decisions #223–#225).
- Dependency: `agent-core==0.4.0` → `agent-core>=0.4.0,<0.8` (a library never exact-pins
  agent-core; #221/#222 forward-port). No code change.

## 0.5.3 — 2026-09-29

- More motion packs ship in the wheel (decision #290): fantasy-03, fantasy-06, fantasy-09 and
  pets-01 to pets-05 under `garage/avatars/packs/<id>/`, built with the 0.5.2 fill tool (#205);
  every pack passes `validate_pack`.
- Dependency: `skills==0.2.1` → `skills==0.2.1.post1` (the wheel agent-core vendors;
  0.2.1 exact-pinned agent-core==0.4.0). No code change.

## 0.5.2 — 2026-09-28

- T46 More motion packs (decision #205): `avatars/tools/clips_to_pack.py` now scales every
  pack so the tallest visible frame anywhere in the pack (not just the idle row) fills
  80-90% of the cell height, one scale for the whole pack, feet anchored to the baseline
  and horizontally centred; `fps` defaults to 6.

## 0.5.1 — 2026-09-28

- T23 round-one theme palettes (decisions #77, #159, #167; `docs/t23/contract.md` §1, §2, §8.5):
  `themes/<id>/theme.yaml` for `arcade`, `desert`, `hitchhiker`, `office`, `robot`, `space`,
  `fantasy` and `pets`, each with light and dark colours drawn from its avatar set's art and an
  `avatar` hint equal to its own id. Type, radius, motion and sounds are Lantern's, unchanged
  (sounds stay `default`). The `lamp` stays a warm amber in every theme: dark variants keep a bright
  gold; light variants use a deep amber (hue 36°) that clears the 3:1 `lamp`/`bg` rule. Every one
  passes `validate_theme` with no errors. `tests/test_themes_shipped.py`: shipped ids are exactly
  the eight plus `lantern`, each has both variants, each round-one theme passes the validator and
  pairs with its own avatar set.
- Lantern light lamp, owner decision: `themes/lantern/theme.yaml`'s `light.colors.lamp` is now
  `200 120 0` (was `240 181 69`) — ~3.14:1 against `light.bg`, clears decision #167's 3:1 `lamp`/`bg`
  rule. The dark lamp is unchanged. This closes the one known gap from 0.5.0: `validate_theme` on
  the bundled `themes/lantern` now returns `[]`, same as every round-one palette, and
  `tests/test_themes_shipped.py`'s full-pass parametrize list includes `lantern` again.
- Muted-text audit: `garage.themes.validate.TEXT_PAIRS` already checks `text-muted` against `bg`,
  `surface` and `surface-raised`, at the 4.5:1 text floor, in both `light.colors` and `dark.colors`
  (`test_contrast_pair_refused_in_each_variant` covers the failing case per pair/variant; every
  shipped palette's passing case is covered by its own full-pass test) — no checker change needed.
  Ran it by hand against all nine shipped palettes (eight round-one plus `lantern`): every one's
  lowest muted-text ratio is comfortably above 4.5:1 (worst case `hitchhiker`, ~5.70:1), so none is
  held back.

## 0.5.0 — 2026-09-28

- T23 theme packs (decisions #77, #78, #167, #188, #197; `docs/t23/contract.md` §3) — playbooks' half
  of the theme-pack checker. `src/garage/themes/contrast.py`: pure WCAG 2.1 relative luminance and
  contrast ratio math, no dependencies. `src/garage/themes/validate.py`: `validate_theme(directory) ->
  list[str]` (same return style as `avatars/validate.py`'s `validate_pack` — empty list is a pass);
  checks `theme.yaml`'s structure against contract §1 (required/optional top-level keys, the 20
  `light.colors`/`dark.colors` keys with no name drift, `type.font` pinned to Figtree, `radius`
  ordering, `motion` ranges and `cubic-bezier` shape, `sounds`) and every §2 AA/AA-UI contrast pair —
  4.5:1 text pairs and 3:1 UI pairs including `lamp` as a solid colour against `bg` — in both
  `light.colors` and `dark.colors`. `themes/lantern/theme.yaml`: the bundled default, byte-identical to
  today's live Lantern (`src/design/tokens.ts`). Kept in step with agent-core's own mirror
  (`anorak.theme_pack`) by contract, not by import — the two repos cannot depend on each other in that
  direction.
  **Known gap, not fixed here:** `themes/lantern/theme.yaml`'s own light-mode `lamp` fails the new §2
  `lamp`/`bg` 3:1 rule (~1.69:1) — a real, pre-existing colour choice, confirmed against WCAG reference
  values elsewhere in the checker, not a bug in it. Flagged for Braden; the shipped values are not
  altered by this PR. See `tests/test_themes_validate.py`.

## 0.4.1 — 2026-09-28

- T46 motion packs — `avatars/tools/clips_to_pack.py`: turns one video clip per state into an
  animated-tier ("More motion") pack in plain code. Input is `<state>/*.png` frame folders
  (the fixed eight, `idle_variant_1..N`, `celebrate`) plus the sprite base the clips start
  from. It keys out the flat background (key colour read off the base's border, soft alpha,
  spill clamp), cuts each clip where it comes back closest to its first frame and picks the
  same N (4-12) evenly spaced frames from every clip, crops every frame of every state with
  one shared box (union of all frames, centred on the resting pose, so the character never
  jumps or rescales between states), quantises to one shared palette and reuses
  `portrait_to_pack`'s look (outline, rim, status brooch, bubbles/card/sparkles, grey paused
  and dimmed offline); the brooch is skipped on frames where the body under it has moved.
  The pack is written by `render_pack` (`tier: animated`, `frames`, `fps`, rows per
  docs/t46/contract.md) and checked with `validate_pack`; a sheet over 2 MB is re-saved as an
  indexed PNG. Optional contact sheet, all-states GIF and per-state GIFs for review.
  `avatars/tools/extract_frames.swift` extracts clip frames with AVFoundation (no ffmpeg, no
  new dependency). Tests use synthetic frames only (`tests/test_avatars_clips.py`).

## 0.4.0

- T46 (decisions #194, #195, #197-#200; playbooks 0.4.0) — animated tier for avatar packs.
  `validate_pack` (`src/garage/avatars/validate.py`, `grid.py`) now accepts an optional `tier`
  (`standard`/`animated`/absent), an optional `frames` (4-12, must equal `grid.columns`) and an
  optional `fps` (6-12, must equal `grid.fps`), plus extra `grid.rows` entries — one or more
  `idle_variant_1`, `idle_variant_2`, ... (numbered from 1, no gaps, at most 8, §8.7) then
  optionally `celebrate` — allowed only under the animated tier. `tier: animated` is refused
  without at least one `idle_variant_N` row and a `celebrate` row (§8.5); every rule reuses the
  existing `grid` error code (paths `tier`, `frames`, `fps`, `grid.rows`). Every pack without
  these keys — Beacon included — still validates byte-for-byte as before. `render_pack`
  (`pack.py`) gains optional `frames`, `fps` and `extra_states` keywords to emit an animated-tier
  pack; called with none of them it still emits today's plain pack unchanged. `build_pack.py`'s
  CLI is untouched (thin: it already just forwards a `Character` to `render_pack`). playbooks
  builds no signed library index, so there is nothing here to add `tier` to (agent-core owns
  that, per the shared contract in `docs/t46/contract.md`).

- T26 (decision #200) — `avatars/tools/portrait_to_pack.py`: idle now breathes a 1 px shoulder
  rise (down, down, up, up) that the head follows; every awake state (idle, working, asking,
  proposal_ready, done, needs_attention) carries a real blink transition, never paused/offline
  where the eyes are already shut; asking adds a small head tilt/shear around the neck. New
  tests cover the exact 1 px rise, the blink confined to the eye boxes, and the tilt leaving the
  body untouched and the silhouette unbroken.

- T26 test — `avatars/tools/portrait_to_pack.py`: one transparent portrait to a standard orb pack in
  plain code (crop, scale, palette-quantise, binary alpha, outline and rim; bob, tilt, blink, a
  status brooch with Beacon's tones, and props per state). No image model and no credits; the pack
  passes `validate_pack.py` unchanged. Test runs it on a synthetic portrait made in the test.

- T26 — avatar generator library, Beacon character, prompts, contact sheets, pack validation
  and score table; build-time Claude skill and optional Pillow tooling (0.3.0, decision #89).

- CI templates: actions/checkout v4 -> v7.0.1 and astral-sh/setup-uv v6 -> v10.2.0, pinned by commit SHA. setup-uv v10 keeps the cache on because the template sets enable-cache: true.

- onboarding-v1 checker `onboarding_profile_complete`: plain code, required fields + valid values
  + venture codes in ventures.yaml (0.2.3, decision #64).

- Shared venture list, code -> full name (playbooks 0.2.2, decision #61).

- Onboarding data ships in the wheel (playbooks 0.2.1). `pyproject.toml` force-includes
  `onboarding/v1/{intro,questions,skill}.yaml` into `garage/onboarding/v1/` so a vendored,
  installed copy of this package (agent-core decision #58) can load its own data;
  `garage.onboarding.data.ONBOARDING_DIR` picks the packaged copy when present and falls back
  to the repo checkout otherwise. The repo's `onboarding/v1/` stays the one source of truth.

- T13 follow-up — onboarding decisions #31/#38. Yes/No page-watch answers mirror into
  `profile.yaml.watch_answers` through `ProfileStore`; Not now is never saved, so the page is
  asked again. Onboarding no longer asks or accepts `access_level`: `load_questions` rejects
  such a question, new profiles default to `member`, and an existing value (such as `admin`)
  survives every run. Tests and fixtures updated to match.

- T13 — add the onboarding skill v1 (`onboarding/v1/`, T10 skill format: intro screens,
  question set with follow-ups, profile writer through agent-core `ProfileStore`, the
  "Can I watch this page?" first-visit prompt with a saved-answers store, second run asks
  only the gaps) and its Python API in `garage.onboarding`. Pin agent-core 0.4.0 and
  skills 0.2.1 via vendored wheels with recorded provenance; PyYAML 6.0.3. Package
  version is 0.2.0; no release has been published.

- T01 — add the reusable template, renderer tests, locked Python tooling and CI.

- 0.1.0 — skeleton created
