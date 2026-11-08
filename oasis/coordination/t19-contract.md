# T19 contract — UI upgrade (desktop-app)

Source: `prompts/20-ui-upgrade.md`, docs/TICKETS.md T19, decisions #77, #84, #104, #116, #124, #127. Every T19 job reads this file. A name a job needs that is not here goes in its `crossJobNames`.

## Fixed by Braden (do not change)

- **Character:** Beacon stays the character (#127). The Orb keeps its 8 states, 3 looks (#74); T19 polishes, it does not replace.
- **Themes:** light and dark, default follows the OS (`prefers-color-scheme`); a Settings choice of System / Light / Dark overrides it (#127).
- **Font:** one family at most, bundled with the app (no network fonts), license allows desktop bundling (OFL/Apache/MIT), legible at 13 px (#127). A system-font fallback stack follows it.
- **Sound cues:** off by default, one on/off toggle in Settings (#127). No other sound settings.
- **Onboarding:** five beats max, under 3 minutes end to end, skippable, re-runnable (asks only gaps, T13) (#127; beats the prompt's "five minutes").
- **Bug-list screens in scope (#127):** #2 Chats page (search box and New chat are unstyled defaults; long names wrap into blocks, must truncate with the full name on hover/focus; Rename/Delete only on row hover/focus or a "…" menu); #3 quick-box message field matches the full composer (rounded, token focus ring, no blue square outline).
- **Layout** (#84, already built in T19 part 1): left rail New chat, Chats, Skills, Connect, Activity, Scoreboard, Recents; Beacon empty state "What should we do today, <first name>?"; bottom composer (attach, ask-before-acting toggle, model picker, mic placeholder). Quick box uses the same composer component.
- **Libraries approved (#124):** `motion` (motiondivision/motion, MIT) and `@formkit/auto-animate` (MIT); pin exact versions in package.json when first used and add a CHANGELOG line saying why. Anything else new needs Braden's yes (list it under Open).
- **Hard limits:** everything in `prompts/20-ui-upgrade.md` "Hard limits" (Tauri 2 + OS webview; Orb has no WebGL and no backdrop-filter; plain words, no jargon; WCAG AA; reduced motion honored with still fallbacks; ask-first and pause the most obvious things on screen; pause one click from every screen; asset ≤ 2 MB; installer growth < 15 MB; no build-ahead for Docs, the Stacks, voice).

## Orchestrator's calls (#127 "your call") — proposed in pass 1, Braden reviews

- **Feel:** warm, calm, alive, trustworthy. Warm paper neutrals in light, warm charcoal in dark (never pure #000/#fff). One accent family tied to the T30 icon's gold visor rim (gold/amber) for brand and the "needs you" state; one calm secondary (deep teal) for links and focus. Status colors (ok / needs you / error / paused) are distinct in hue AND shape/icon, never color alone.
- **Ask-first card:** the most prominent surface in any view: gold rim, plain-words header ("Waiting for your Yes"), Yes/No as the two biggest buttons on screen. Never stacked (#29).
- **Pause:** always-visible control at the top of the rail (and in the orb menu, quick box header); paused state tints the whole shell and says so in words.
- **Type scale:** 13 px base for dense lists, 15 px chat body, 1.25 ratio; tabular numbers in Activity/Scoreboard.
- **Motion:** calm, no bounce. 120 ms (hover/press), 200 ms (panels, cards in), 320 ms (onboarding beats); ease-out in, ease-in out. Reduced motion → 0 ms transitions and still frames.
- **Sound cues:** three short cues synthesized with the Web Audio API at runtime (no audio files): "needs you" (ask-first card appears), "done" (plan finished), "problem" (a step failed). Volume fixed and quiet.
- **Onboarding beats (≤ 5, < 3 min):** 1) Hi, I'm Beacon (who I am, 1 line + Beacon); 2) What I can see (only what you connect; nothing else); 3) What I never do without you (every send/move/reply waits for your Yes — shows a mini card); 4) How to pause me (points at the pause control; try it); 5) A few questions (the profile gaps only; writes `profile.yaml`). Skip is visible on every beat.

## Pass-1 picks from the scout (coordination/research/t19; .swarm/scouts/scout-1790390571176)

- **Font: Figtree** variable (300–900), OFL 1.1, pinned `erikdkennedy/figtree@032dfa7fe219ef3a02890d6d3add84eacc9aebfe`, bundled at `src/assets/fonts/Figtree-Variable.ttf` with `OFL.txt` + `README.md` (already committed by the coordinator; do not replace). Load with `@font-face` from the bundled file; fallback stack `system-ui, -apple-system, "Segoe UI", sans-serif`.
- **No other new dependencies** besides `motion` and `@formkit/auto-animate` (#124). Write these in-house instead: the WCAG contrast check (relative-luminance formula, ~20 lines, `scripts/check-contrast.ts` + a vitest test that runs it over every token text/background pair in both themes); the theme hook (system-follow via `matchMedia('(prefers-color-scheme: dark)')` + Settings override, no flash on start); the three sound cues (Web Audio oscillator + gain envelope, `src/design/sound.ts`, no audio files, silent unless `sound` is on).

## Tokens (the runtime interface; T23 packs replace the values, never the names)

`src/design/tokens.ts` exports `tokens` (light + dark sets) and `applyTokens(theme)` that writes CSS custom properties on `:root`. Names:

- Color: `--oasis-bg`, `--oasis-surface`, `--oasis-surface-raised`, `--oasis-border`, `--oasis-text`, `--oasis-text-muted`, `--oasis-accent`, `--oasis-accent-text`, `--oasis-focus`, `--oasis-link`, `--oasis-ok`, `--oasis-needs-you`, `--oasis-error`, `--oasis-paused`.
- Type: `--oasis-font`, `--oasis-font-size-sm`, `--oasis-font-size-base`, `--oasis-font-size-chat`, `--oasis-font-size-lg`, `--oasis-font-size-xl`, `--oasis-line-height`.
- Space: `--oasis-space-1` … `--oasis-space-8` (4 px steps: 4, 8, 12, 16, 24, 32, 48, 64).
- Radius: `--oasis-radius-sm`, `--oasis-radius-md`, `--oasis-radius-lg`, `--oasis-radius-pill`.
- Elevation: `--oasis-shadow-1`, `--oasis-shadow-2`.
- Motion: `--oasis-duration-fast`, `--oasis-duration-base`, `--oasis-duration-slow`, `--oasis-ease-out`, `--oasis-ease-in`.

Existing `--oasis-*` names from T19 part 1 are kept or aliased; a job that renames one lists it in `crossJobNames`.

Settings keys (local UI prefs, not profile): `theme: "system" | "light" | "dark"`, `sound: boolean` (default false).

## PR plan (one PR per surface, per the prompt)

1. **System + Orb + fixes #2/#3** — tokens, font, theme setting, sound toggle + cues, restyle every existing screen onto tokens, Chats page (#2), quick field (#3), Orb polish, `docs/design/audit.md`, `docs/design/system.md`, pass-1 screenshots. ← **pass 1 is shown to Braden here, before PRs 2–5.**
2. Onboarding story (five beats).
3. Side panel + chat, **including T41** (decision #129): safe Markdown subset renderer in chat bubbles (full chat + quick box) + the agent-core reply-shape instruction PR (fixed wording in system text, #73).
4. Connect.
5. Activity + Scoreboard.

Then passes 2 and 3 (`docs/design/pass-N.md`, before/after, score /10; stop at ≥ 9), and the pre-flight checklist in the final PR body.

## Checks every T19 PR runs

`npm run typecheck`, `npx eslint src tests scripts`, `npm test`, vitest ×5, `git diff --check`, `npm run preview:screens -- --view all --theme both` (must pass), and a contrast check (added in PR 1) that fails CI below WCAG AA for every token text/background pair in both themes.

## Pass-1 notes (Braden, 2026-09-25, decision #130) — apply before PR 1 ships

- **Kept as is:** Figtree; gold accent; ask-first card; Home layout; dark theme gets the same notes as light.
- **Pause (was too quiet):** when paused, a banner runs across the top of the main area (full width of the content column, above the chat), plain words, with the Resume action in it. Beacon visibly changes to a paused/asleep look (orb window and the Beacon on Home): visor light off, sprite dimmed, slow breathing (still under reduced motion), a small two-bar pause mark; clearly different from idle and from offline (offline keeps its dark dot). Engine effect only, no new art frames (packs keep working). The Pause button itself gets the gold outline (≥ 3:1 against its background, both themes) so it reads as important.
- **Home:** the question uses the person's first name ("What should we do today, Amber?") once the profile is loaded; before that, or with no first name, the question has no name and no stray comma.
- **Chats page:** search and New chat on one line; lighter rows.
- **Scope:** general Orb polish moves to PR 2 with the onboarding story (Braden: "PR 2's story and orb polish should close it"). PR 1 touches the orb only for the paused look.
- **Order:** apply notes → outside (Opus director) critique round → fix what it finds → ship PR 1.
- **Paused beats every Beacon state (#132):** orb and Home Beacon stay asleep while paused, even while a reply runs. The composer (full chat + quick box) shows its own "working…" mark while a reply is running, paused or not.
