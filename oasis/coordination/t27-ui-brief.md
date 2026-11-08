# T27 part 3 brief — PreviewCard, plan report, Undo, note (desktop-app)

Decisions #73, #94, #95, #97, #99, #102, #104. The wire format below is the contract; agent-core
0.7.0 (branch t27-chat-tools) sends exactly these frames. Nothing here adds an API.

## Wire (WebSocket `/chat`, same on the full chat and the quick box)

- server → Rig `preview`: `{"type":"preview","thread_id","preview_id","token","summary","actions":[{"n","tool","summary","content"}]}`
  (`content` is the exact object that will run; every recipient spelled out).
- Rig → server `confirm`: `{"type":"confirm","thread_id","preview_id","token","answer":"yes"|"no"}` — exactly these keys.
- server → Rig: `{"type":"confirmed","thread_id","preview_id","ok","results":[{"n","ok","detail"}]}` |
  `{"type":"declined","thread_id","preview_id"}` | `{"type":"expired","thread_id","preview_id"}`.
- server → Rig `plan_report`: `{"type":"plan_report","thread_id","preview_id","text","steps":[{"n","tool","summary","ok","detail","link","undo":{"preview_id","token","summary"}|null}],"watching":[]}`.
  An Undo is confirmed with the normal `confirm` (answer `yes`, its own preview_id + token).
- `GET /chats/{id}` messages may carry `note` (assistant only), e.g. `Used: Outlook inbox (read), Outlook reply (waiting for Yes)`.
- Frame order on a plan turn: `chunk` (answer) → `preview` → `done`. After Yes: `confirmed` → `plan_report`.
  The report text is also saved as an assistant message in the thread, so a reload shows it as a normal message.

## What to build

1. `serviceClient` handles `preview` / `confirmed` / `declined` / `expired` / `plan_report` and sends `confirm`.
   Unknown frame types are ignored (never crash, never shown).
2. **PreviewCard** (full chat and quick box, one shared component): the plan `summary` as the title, then
   every action in order, numbered, with its exact `content`:
   mail = To, Cc, Subject, body (full body, scrollable past ~8 lines, never cut silently);
   events = title, start–end in the person's local time, place, people;
   files = name, folder, people + role; Teams = chat or team/channel + the text;
   anything else = the action `summary` plus its fields as label: value rows.
   ONE **Yes** and ONE **No** for the whole plan. Tap sends `confirm` once, then both disable and show
   "Working…" (Yes) or nothing more (No). A second tap or a double-click never sends a second confirm.
3. After `confirmed`: each action row shows ✓ or ✗ and its `detail`. `declined` → the card reads
   "Not done." muted. `expired` → "This plan expired. Ask again." muted, buttons gone. Nothing is ever
   shown as done unless a `confirmed` result says `ok: true` for it.
4. **Plan report** renders in the thread as its own block: each step in order with ✓/✗, its summary and
   detail, the link as "Open" (opens in the system browser via the existing `openExternal` in
   src/lib/platform.ts; never navigates the app webview), and an **Undo** button where `undo` is set.
   Undo sends one `confirm` (answer yes), then disables and shows "Undoing…"; its own `confirmed` /
   `expired` result replaces that, and the Undo's own `plan_report` arrives as a new report block. "Sent — can't be unsent" steps have no Undo. `watching: []` shows nothing.
5. `note` renders muted, small, under the assistant answer it belongs to (live and after reload).
6. A new message from the person in that thread makes any open card's buttons stale: the server will
   answer `expired`; the UI shows that state. No client-side timers or clocks.

## Visual rules

- Token-based styles only (T19/#77): colors, radii, spacing from the `:root` / `prefers-color-scheme`
  token blocks in src/styles.css (and quick.css for the quick box). Add new tokens there if needed; the
  existing literal-color test must stay green. Light and dark both at WCAG AA.
- The card sits in the thread flow, aligned with assistant messages, full message width, a quiet
  border, no drop shadow bigger than existing ones. Yes is the primary button, No secondary; both
  at least 32 px tall; keyboard reachable; Yes is not auto-focused.
- Quick box: same component, compact spacing; the body can collapse to 3 lines with "Show all".
- Plain text only (decision #66): render every string from the service as text, never as HTML/markdown.

## Screenshot loop (Astra)

Extend `scripts/preview-screens.ts` + the fake service with views: `preview` (a 2-action plan: a reply
with To/Cc/Subject/body + a mail move), `confirmed` (one ok, one failed), `report` (steps with Open
links and one Undo), `expired`, and `quick-preview`. Run
`PLAYWRIGHT_BROWSERS_PATH=/private/tmp/oasis-t01-tools/ms-playwright npm run preview:screens -- --out .pilot/t27-rN --view <view> --theme both`
and look at every PNG before you finish.

## Tests (vitest)

- Card shows every action's exact content, including every recipient; Yes sends exactly one `confirm`
  with the five keys and answer `yes`; No sends `no`; double-click sends one; buttons disable after.
- `confirmed` marks per-action results; nothing shows done without `ok: true`; `expired` / `declined` states.
- Report: links render as Open and call the opener, never `window.location`; Undo sends one confirm with the
  undo's own preview_id/token; no Undo when `undo` is null.
- `note` shows muted under its answer, live and from `GET /chats/{id}`.
- Strings with `<b>` or `[x](y)` render literally.
- Quick box shows the same card and sends the same confirm.

## Must keep working

Everything under T19 part 1 (rail, empty state, Recents), streaming chat, quick box, orb, voice, Settings.

## Out of scope

Standing permissions (T28), feedback thumbs (T29), editing a plan before Yes, any agent-core change.
