# T24 shared contract — Quick chat under the orb

Source: docs/TICKETS.md T24, decisions #71, #74, #83, #85. Only the coordinator edits this file.
Every name below is fixed. A worker that needs a cross-job name not listed here reports it in `crossJobNames` and does not invent one.

## Scope rules (decision #85)
- `asking` is NOT built in T24. No job touches any ask-first gate, confirm_token flow, or `risky_steps` code. The orb keeps its existing `asking` mapping unchanged.
- "Last used thread" = the last thread that (a) a WS /chat `send` landed in, (b) was created by `POST /chats`, or (c) was opened in the full app via `POST /chats/:id/open`. New install (nothing stored yet): the newest thread (#71). Stored thread deleted: the newest thread. No threads: `null`.

## agent-core (0.6.17 → 0.6.18) — job A
| Name | Shape |
|---|---|
| `GET /chats` | unchanged `threads` list, plus top-level `"last_used": "<thread_id>" \| null` → `200 {"threads": [...], "last_used": "..."}` |
| `POST /chats/:id/open` | body ignored (send `{}`); marks the thread last used → `200 {"thread_id": "<id>"}`; `404 {"error": "unknown_thread"}`; `503 {"error": "chats_unavailable"}`. Same auth as the other /chats routes. |
| WS /chat `send` | unchanged; additionally marks the thread it lands in (given `thread_id`, or the default newest) as last used, before the reply streams. |
| `POST /chats` | unchanged; additionally marks the new thread last used. |
| Persistence | the marker survives a service restart (stored in the drawer alongside the chat store). Reads never write. |

GET routes stay read-only. No other endpoint changes.

## desktop-app — jobs D1 (Rust/config) and D2 (TypeScript)

### Windows and files
| Name | Owner | Shape |
|---|---|---|
| window label `quick` | D1 | in `src-tauri/tauri.conf.json`: url `quick.html`, width 360, height 320, `visible: false`, `decorations: false`, `transparent: true`, `alwaysOnTop: true`, `skipTaskbar: true`, `resizable: false`, `shadow: false`, `focus: true` |
| `quick.html` | D1 | HTML entry at repo root like `orb.html`, loads `/src/quick/main.tsx` |
| `vite.config.ts` input `quick` | D1 | third entry `quick: ${rootDir}quick.html` |
| `src-tauri/capabilities/quick.json` | D1 | identifier `quick-capability`, windows `["quick"]`, permissions `core:default`, `core:event:allow-listen`, `core:event:allow-unlisten`, `core:event:allow-emit`, `core:event:allow-emit-to` |
| `src/quick/main.tsx`, `src/quick/QuickApp.tsx`, `src/quick/quick.css` | D2 | the box UI |
| `src/components/Composer.tsx` | D2 | shared composer (see below) |

### Tauri commands (Rust, D1; TypeScript calls them via `invoke`)
| Command | Args | Behavior |
|---|---|---|
| `toggle_quick` | none | quick hidden → position it (see Placement), show, focus, emit `quick-shown` to window `quick`; quick visible → hide it. |
| `show_quick` | none | like the show half of `toggle_quick` (idempotent). |
| `hide_quick` | none | hide the quick window (never destroy it; the draft lives in its JS state). |
| `open_chat` | `{ threadId?: string }` (Rust `thread_id: Option<String>`) | as today (show + focus main, emit `open-chat`), and the `open-chat` payload is now `{ "thread_id": string \| null }`. Also hides the quick window. |

Global shortcut `Ctrl+Space` now calls the `toggle_quick` logic (it no longer toggles the main panel). `toggle_panel` stays as a command (the menu may use it) but nothing binds it to Ctrl+Space.

Click-away: when the quick window loses focus (Tauri `WindowEvent::Focused(false)`), Rust hides it. Esc is handled in TS by invoking `hide_quick`.

### Placement (D1, pure function in `src-tauri/src/logic.rs`)
`pub fn quick_box_position(orb: Rect, box_size: (f64, f64), work_area: Rect, gap: f64) -> (f64, f64)` with `pub struct Rect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }` (logical pixels).
- Horizontal: centered on the orb's center, then clamped so the box is fully inside `work_area`.
- Vertical: below the orb (`orb.y + orb.h + gap`) when it fits inside `work_area`; else above (`orb.y - gap - box_h`); if neither fits, clamped inside `work_area`.
- `gap` = 8. The box is never partly off screen. The work area is the monitor the orb is on.

### Events (Tauri)
| Event | From → to | Payload |
|---|---|---|
| `quick-shown` | Rust → window `quick` | none. The box re-fetches `GET /chats` (for `last_used`) and that thread, and focuses the input. |
| `quick-chat-state` | window `quick` → window `orb` (`emitTo('orb', ...)`) | `{ "working": boolean }`. `true` right after a send, `false` on `done` or `error` or socket close. |
| `open-chat` | Rust → window `main` | `{ "thread_id": string \| null }` (was no payload). Main selects that thread when non-null. |

### Orb (D2, `src/orb/OrbApp.tsx`)
- Left click on the character: `invoke('toggle_quick')` (was `toggle_panel`).
- The chat (write) button: `invoke('show_quick')` (was `open_chat`).
- Right-click menu unchanged.
- State: `displayed = localWorking ? 'working' : polledState`, where `localWorking` is the last `quick-chat-state.working`. Polling every 3 s stays. The mapping `statusState()` in `src/orb/looks.ts` is otherwise unchanged; `asking` mapping untouched.

### Shared composer (D2, `src/components/Composer.tsx`)
`export function Composer(props: { value: string; onChange: (v: string) => void; onSend: () => void; disabled?: boolean; placeholder?: string; autoFocus?: boolean; inputRef?: React.Ref<HTMLTextAreaElement | HTMLInputElement> })`. Enter sends, Shift+Enter is a newline (if textarea), send button disabled when value is blank or `disabled`. Chat.tsx and QuickApp.tsx both use it. T19 will add attach, ask-before-acting, route picker and mic to it; T24 ships input + send only.

### Service client (D2, `src/lib/serviceClient.ts`)
- `listChats()` result gains `last_used: string | null`.
- new `openChatThread(baseUrl, threadId)` → `POST /chats/:id/open` `{}` → `{ thread_id }`.

### Box behavior (D2)
- Shows: the last 3 exchanges of the last-used thread (an exchange = one user message and the assistant replies after it; take the last 3 user messages and everything after the first of them), the Composer, and an "Open full app" link that calls `invoke('open_chat', { threadId })`.
- Sends through WS /chat with `thread_id` = the box's current thread; streams the reply into the box; after `done`, re-fetches the thread.
- Esc → `invoke('hide_quick')`. The draft text is kept in state across hide/show.
- Plain text only (decision #66). Every request path handles rejection with a plain message.

### Full app (D2)
- ChatRail: on mount and on window focus, select `last_used` from `GET /chats` (fallback newest when null). Clicking a thread calls `openChatThread` (then loads it as today). `open-chat` with a non-null `thread_id` selects that thread.
