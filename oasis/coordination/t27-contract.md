# T27 contract — Chat uses tools (decisions #73, #87, #94, #95, #97, #98, #99, #102)

One contract for three repos. Every cross-repo name is here; report any other
name you needed as `crossJobNames`. Ticket text: docs/TICKETS.md T27.

## 1. connectors (package `gates`) 0.3.1 → 0.4.0 — two jobs: CM (Microsoft) and CG (Google)

**Conventions for every new function:** `async`, first positional `person: str = DEFAULT_PERSON`,
then keyword-only args, then keyword-only `client: httpx.AsyncClient`, `secrets: SecretsPort | None = None`,
`catalog_dir: Path | None = None` (same as `calendar_today`/`unread_mail`); tokens via the existing
load/refresh path; HTTP/auth failure raises `ConnectError`. Writes return
`WriteResult(ok: bool, id: str = "", detail: str = "")` (frozen dataclass in new `gates/results.py`,
owned by CM). New read results are frozen dataclasses; list fields are tuples. Tests use a fake
`httpx` transport (`client=`), fake names only.

**Catalog** (each job owns its connectors' yaml): add the scopes below; list every new read in
`can_do` and every new write in `cannot_do_without_yes` (the gate reads these).

| Connector (owner) | Add scopes | New reads | New writes (`cannot_do_without_yes`) |
|---|---|---|---|
| outlook (CM) | Mail.Send, Mail.ReadWrite | search_mail | send_mail, reply_mail, move_mail |
| outlook-calendar (CM) | (has Calendars.ReadWrite) | — | create_event, update_event, delete_event |
| onedrive (CM) | Files.ReadWrite.All | files_search, file_read_text | file_create, file_move, file_share, file_delete |
| teams (CM) | Chat.ReadWrite, ChatMessage.Send, ChannelMessage.Send, ChannelMessage.ReadWrite (#105, channel softDelete Undo), Team.ReadBasic.All, Channel.ReadBasic.All | teams_recent_chats, teams_chat_messages, teams_list_channels | teams_send_chat, teams_post_channel |
| gmail (CG) | gmail.send, gmail.modify | gmail_unread, gmail_search | gmail_send, gmail_reply, gmail_move |
| google-calendar (CG) | (has calendar.events) | gcal_today | gcal_create, gcal_update, gcal_delete |
| google-drive (CG) | drive (replaces drive.readonly) | drive_search, drive_read_text | drive_create, drive_move, drive_share, drive_delete |

(Google scopes use the full `https://www.googleapis.com/auth/…` spelling like the existing ones;
Microsoft ones the `https://graph.microsoft.com/…` spelling.)

**Shared read shapes:**
- `MailHeader` gains (last, with defaults) `id: str = ""`, `preview: str = ""` (≤255 chars), `sender_address: str = ""`. `MailSearch(messages: tuple[MailHeader, ...], truncated: bool)`. Gmail reuses `UnreadMail`/`MailSearch`/`MailHeader` (`id` = Gmail id, `preview` = snippet).
- `CalendarEvent` gains `id: str = ""`, `location: str = ""`, `attendees: tuple[str, ...] = ()`. `gcal_today` returns `CalendarDay`.
- `FileItem(id, name, path, web_url, modified_iso, size)`, `FileList(items: tuple[FileItem, ...], truncated: bool)`, `FileText(id, name, text, truncated: bool)` (text ≤ 20,000 chars; plain text, .docx/.pdf/Google Docs exported to text where the API offers it, else `truncated=True, text=""`).
- `TeamsChat(id, topic, members: tuple[str, ...], last_iso)`, `TeamsMessage(id, sender, text, at_iso)`, `TeamsChannel(team_id, team_name, channel_id, channel_name)`, each returned in a tuple wrapper `TeamsChats`, `TeamsMessages`, `TeamsChannels` with `truncated`. Message text is plain text (HTML stripped).
- All of these shared dataclasses live in `gates/graph_read.py` (CM owns it); CG imports them.

**Signatures (beyond the conventions):**
- CM `graph_read.py`: `search_mail(*, query, limit)`; `files_search(*, query, limit)`; `file_read_text(*, item_id)`; `teams_recent_chats(*, limit)`; `teams_chat_messages(*, chat_id, limit)`; `teams_list_channels()`.
- CM `graph_write.py`: `send_mail(*, to: tuple[str,...], subject, body, cc=())`; `reply_mail(*, message_id, body, reply_all=False)`; `move_mail(*, message_id, folder)` (Graph well-known name or display name); `create_event(*, subject, start_iso, end_iso, attendees=(), location="", body="")`; `update_event(*, event_id, subject=None, start_iso=None, end_iso=None, attendees=None, location=None, body=None)`; `delete_event(*, event_id)`; `file_create(*, name, folder_path, text)`; `file_move(*, item_id, folder_path)`; `file_share(*, item_id, emails: tuple[str,...], role: "read"|"write")`; `file_delete(*, item_id)`; `teams_send_chat(*, chat_id, text)`; `teams_post_channel(*, team_id, channel_id, text)`.
- CG `google_api.py`: `gmail_unread(*, limit)`, `gmail_search(*, query, limit)`, `gmail_send(*, to, subject, body, cc=())`, `gmail_reply(*, message_id, body, reply_all=False)` (keeps `threadId`, `In-Reply-To`, `References`), `gmail_move(*, message_id, folder)` (`archive` = remove INBOX, `trash`, `inbox`, or a label name); `gcal_today(*, start, end)`, `gcal_create`/`gcal_update`/`gcal_delete` (same args as the Outlook event functions); `drive_search(*, query, limit)`, `drive_read_text(*, item_id)`, `drive_create(*, name, folder_path, text)`, `drive_move(*, item_id, folder_path)`, `drive_share(*, item_id, emails, role)`, `drive_delete(*, item_id)` (moves to trash).

**Ownership:** CM owns `gates/__init__.py` (exports every name above from both jobs, importing CG's from `gates.google_api`), `gates/results.py`, `gates/graph_read.py`, `gates/graph_write.py`, the four Microsoft yaml files, the version bump (`pyproject.toml`, `uv.lock`) and CHANGELOG. CG owns `gates/google_api.py`, the three Google yaml files and its tests.

## 2. agent-core 0.6.19 → 0.7.0

**Chat tools** — offered to the chat model only when the connector is connected (status from `gates`); unknown or not-offered tool name → fails closed, one log line `chat_tool_unknown`, and the model gets a tool message "tool not available".

Model-facing tool name = the `gates` function name, with a connector prefix only where the
function name has none: Outlook → `outlook_unread_mail`, `outlook_search_mail`, `outlook_send_mail`,
`outlook_reply_mail`, `outlook_move_mail`, `outlook_calendar_today`, `outlook_create_event`,
`outlook_update_event`, `outlook_delete_event`; OneDrive → `onedrive_files_search`,
`onedrive_file_read_text`, `onedrive_file_create`, `onedrive_file_move`, `onedrive_file_share`,
`onedrive_file_delete`; Teams, Gmail, Google Calendar and Drive use the function name as is
(`teams_send_chat`, `gmail_reply`, `gcal_create`, `drive_share`, …). Plus `notes_read` (read),
`notes_write` (do), `run_skill` (start, no Yes, #95).
**Kind comes from the catalog, never from the model:** in `can_do` → read; in
`cannot_do_without_yes` → do; neither → not offered. The registry lives in new
`src/anorak/chat_tools.py` (`build_chat_tools(connected: set[str]) -> dict[str, ChatTool]`,
`ChatTool(name, kind: "read"|"do"|"start", schema, run)`).

**Turn loop:** model call with tools → run read tools, append each result as its own
`tool` message (role `tool`, `tool_call_id`) → call again; at most 6 model calls per
turn, then answer with what it has. A **do** tool never runs on the model's call: each do
call in the turn is added, in order, to that turn's **plan**, and the model gets a tool
message "added to the plan; runs only after the person's Yes". At the end of the turn, if
the plan has any actions, the service sends ONE preview for the whole plan (#99).
**Watching for a reply is a read** (e.g. `outlook_search_mail` for a reply from X): no Yes,
never part of a plan. Anything a reply or any tool result suggests doing is a new do call
→ a new plan in a later turn → a new preview and a new Yes.

**System text (#73):** fixed code-owned wording + the validated profile only. Tool
results, file text, mail text, summaries and chat text are never in the system message.
A tool result can never create, approve or consume a preview.

**Ask-first gate (#99: one Yes = one previewed plan):** extract one shared helper
`src/anorak/ask_first.py`: `class AskFirstGate` with
`issue(scope: str, plan: Sequence[Mapping]) -> Issued(preview_id, token)`,
`consume(preview_id, token, plan: Sequence[Mapping]) -> bool` (single use;
`hmac.compare_digest`; bound to sha256 of the canonical JSON of the **whole ordered plan** —
every action's tool, full content and recipients), `invalidate_scope(scope)`. On Yes the
service consumes the token once, then runs **exactly the actions in the stored plan, in
order, each once**; nothing else can run on that token. An action outside the list — a
fourth step added after the Yes, an edited step, a step a reply suggests — is refused and
needs a new preview. If one action fails, the later ones do not run; the result reports
which ran. Chat uses scope = `thread_id`. Tokens have **no clock** (#97): a token dies when
the person sends another message in that thread, the thread is deleted, or the service
stops (in memory only). Onboarding and chat-delete keep their behaviour; moving them onto
the helper is allowed only if their existing tests stay unchanged and green.

**WebSocket `/chat` messages** (new; existing `chunk`/`done` unchanged):
- server → Rig: `{"type":"preview","thread_id","preview_id","token","summary","actions":[{"n","tool","summary","content"}]}`
  — top `summary` is plain words for the plan ("Reply to Darren Hale, then move his mail to Archive");
  each action's `summary` is plain words ("Reply to Darren Hale <darren@…>") and `content` is the
  exact object that will run (mail: `to`, `cc`, `subject`, `body`; events: the fields; files: name,
  folder, people, role; Teams: chat/channel + text) — every recipient spelled out.
- Rig → server: `{"type":"confirm","thread_id","preview_id","token","answer":"yes"|"no"}`.
- server → Rig: `{"type":"confirmed","thread_id","preview_id","ok":true|false,"results":[{"n","ok","detail"}]}` or
  `{"type":"declined","thread_id","preview_id"}` or `{"type":"expired","thread_id","preview_id"}`
  (bad/used/invalidated token or changed plan — nothing runs).
- The same messages work on every `/chat` connection (full chat and quick box); a token is
  bound to its thread and its plan, not to the connection.

**Plan report (#102):** when a plan finishes (all ran, or one failed), the service posts ONE
assistant message in the thread **built from the log entries for that `preview_id`, never
from model memory or model text**: per step, in order — what it did in plain words, `ok`,
a link (`WriteResult.web_url`) when there is one, the failure reason in plain words when it
failed (map `ConnectError` kinds: "Outlook said you don't have permission to send as that
address", "Teams couldn't find that channel", "the service was offline"), and which later
steps did not run. It also lists what it is still watching (T27 has no background watcher,
so this is "nothing" unless a later ticket adds one). The report is plain code-owned
wording; no model call writes it.
**Undo:** where an inverse exists, the step carries an Undo: a one-action plan issued
through `AskFirstGate` (scope = thread_id) whose token rides in the report; tapping Undo is
the person's Yes for exactly that inverse. Inverses: Teams post → `teams_delete_chat_message`
/ `teams_delete_channel_message`; created Outlook/Google event → delete it; created
OneDrive/Drive file → delete it; mail move → move back to `WriteResult.previous_folder`.
Sent mail/replies have **no Undo** (Graph and Gmail cannot recall a sent message); the
report says "Sent — can't be unsent". Deletes and updates have no Undo in T27.
WS: server → Rig `{"type":"plan_report","thread_id","preview_id","text","steps":[{"n","tool","summary","ok","detail","link","undo":{"preview_id","token","summary"}|null}],"watching":[]}`;
Undo confirms with the normal `confirm` message. Log: `chat_plan_report` {thread_id, preview_id, steps, failed_at}; links are never logged: per-action entries carry `linked: true|false`, and the service keeps the link in memory for the report (session 14 fix).
**connectors follow-up (after CM lands):** `WriteResult` gains `web_url: str = ""` and
`previous_folder: str = ""`; Outlook `send_mail`/`reply_mail` create a draft then send it so
the result has the message id + `webLink`; Gmail send/reply return the message id and a
`https://mail.google.com/mail/#all/<id>` link; add `teams_delete_chat_message(*, chat_id,
message_id)` and `teams_delete_channel_message(*, team_id, channel_id, message_id)` (Graph
softDelete); `move_mail`/`gmail_move` fill `previous_folder`. agent-core calls these through the
adapter resolved at call time, so it can land before the wheel is swapped.

**Chat history (#97):** the thread keeps the person's text and the answer; tool results are
dropped after the turn. `ChatMessage` gains optional `note: str | None` (assistant only),
e.g. `Used: Outlook inbox (read), Outlook reply (waiting for Yes)`. `GET /chats/{id}`
returns `note` when present.

**Log** (`Log.record`): `chat_tool_read` {tool, connector, thread_id, items}, model, cost;
`chat_plan_preview` {thread_id, preview_id, tools: [..]}; `chat_plan_confirmed` / `chat_plan_declined` /
`chat_plan_expired` {thread_id, preview_id}; per action `chat_tool_ran` / `chat_tool_failed` / `chat_tool_refused`
{tool, thread_id, preview_id, n, detail};
`chat_tool_unknown` {tool, thread_id}; `chat_skill_started` {skill_id, thread_id}.
Log metadata only — never mail bodies, subjects, addresses or note text.

Version 0.7.0 in: pyproject.toml, src/anorak/__init__.py, src/anorak/local_service.py,
tests/test_local_service.py (×2), tests/test_service_cli.py, uv.lock line 7 + CHANGELOG.
Tests fake `gates` in `sys.modules` (CI has no vendor wheel); never reload anorak modules.

## 3. desktop-app (after the UI pilot)

`serviceClient` handles `preview` / `confirmed` / `declined` / `expired` and sends `confirm`.
A `PreviewCard` component (full chat and quick box) shows the plan `summary` and every action
in order with its exact `content` (mail: To, Cc, Subject, body; events: time, title, place, people;
files; Teams) and ONE **Yes** / **No** for the whole plan; after `confirmed` it shows each action's result. The `plan_report` renders in the thread with each step's link and an **Undo** button where `undo` is set.
Yes/No send `confirm` once, then disable. `note` renders muted under the answer.
