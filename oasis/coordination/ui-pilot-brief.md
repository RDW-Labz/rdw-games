# UI pilot brief — T19 first screen (decisions #84, #93, #96, #77)

This is the shared contract for both pilot arms. Build the full app's first screen:
a left rail plus the empty state. **Layout only** — the reference image
(`app-layout-ref.png`, another product) shows placement and proportion, not the look.
Never copy its names, icons, logo or wording.

## Screen (full app window, main `index.html`, 1280×800 default)

**Left rail** (fixed width ≈ 260–280 px, full height, its own background token):
1. Top block, in this order, one row each with a small icon + label:
   `New chat`, `Chats`, `Skills`, `Connect`, `Activity`, `Scoreboard`.
2. Then a muted section label `Recents` and the most recent chat threads
   (title only, one line, ellipsis on overflow), newest first, at most 8.
   Clicking one opens that thread in the main area.
3. Bottom row, pinned to the foot of the rail: connection status (a small dot +
   today's status text, e.g. "Connected") on the left, the Settings gear on the right.
   The gear opens today's Settings screen; its Back returns to where you were.

**Rail behaviour:**
- `New chat` starts a new chat (today's ChatRail "New chat" behaviour) and shows the empty state.
- `Chats` shows today's thread list with search, rename and delete (reuse `ChatRail`'s list) in the main area.
- `Connect` and `Activity` show today's Connect and ActivityLog screens in the main area.
- `Skills` and `Scoreboard` open a one-line panel: "Coming soon." (#96).
- The current item is visibly selected (token-based background), keyboard focusable,
  with `aria-current="page"`. The rail is a `<nav aria-label="Main">`.

**Empty state** (main area, when no thread is open):
- Beacon centered horizontally, above the greeting, at 96 px (use the existing
  avatar pack / static idle frame the orb uses; no animation needed).
- Greeting centered under it: `What should we do today, <first name>?` using the
  signed-in profile's first name **only if `src/lib/serviceClient.ts` already exposes
  it**; otherwise exactly `What should we do today?`. No new API (#96).
- The composer sits at the bottom of the main area, centered, max width ≈ 720 px:
  today's `Composer` (send + mic) — no attach, toggle or model picker (#96).
  Sending from the empty state starts a thread and shows it, exactly as today.
- An open thread shows today's Chat view in the main area with the same composer.

**Remove** the top header (StatusHeader + tabs); its status and gear move to the rail's bottom row.

## Styles (token-based, #77)
- Every color, spacing step, radius, font size and the rail width is a CSS custom
  property on `:root` in `src/styles.css`, named `--oasis-*` (keep the existing
  `--oasis-bg/-panel/-text/-muted/-accent/-glow/-paused/-danger`). Components use
  `var(--oasis-…)` only — no literal colors or px sizes outside the token block.
- Light and dark variants via `prefers-color-scheme`; both must read well
  (text vs background at least WCAG AA, 4.5:1 for body text).
- System font stack. Quiet, calm, generous spacing. No gradients required.

## Must keep working (tests will check)
- Sign-in first, onboarding, Settings open/Back, thread create/select/rename/delete,
  send carries `thread_id`, chat text `white-space: pre-wrap` + `overflow-wrap: anywhere`.
- `scripts/preview-screens.ts` must still capture the app view (it currently waits for
  the "Connected" status text; keep that text reachable in the rail's bottom row, or
  update the wait).
- Quick box (`src/quick/`) and orb (`src/orb/`) are untouched.

## Fixed names (cross-job)
- New components: `src/components/AppRail.tsx` (export `AppRail`),
  `src/components/EmptyState.tsx` (export `EmptyState`),
  `src/components/ComingSoon.tsx` (export `ComingSoon`).
- New tests: `tests/AppRail.test.tsx`, `tests/EmptyState.test.tsx`.
- Rail section ids (for `data-section`): `new-chat`, `chats`, `skills`, `connect`,
  `activity`, `scoreboard`.
- Report any other cross-job name you needed as `crossJobNames`.

## Out of scope
Attach, ask-before-acting toggle, model picker, themes switcher, new service APIs,
Rust/Tauri changes, version bumps (desktop-app stays 0.1.0; add one CHANGELOG entry).

## Rules
- Plain-text chat replies (decision #66). Art is original only (#75, #76).
- No model input is built in this job; nothing goes into system instructions.
