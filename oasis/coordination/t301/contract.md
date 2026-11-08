# T301 contract — send-from account on the Yes card (decision #301)

Shared by the agent-core job (t301a) and the desktop-app job (t301d). Any name a job needs that is not here goes in its `crossJobNames` reply.

## Rule
When 2+ mail connectors (gmail, outlook) are connected, every mail send/reply action on a Yes card shows which account it sends from. A new send (not a reply) can be switched to the other connected account before Yes. Nothing picks an account silently: the model still picks a tool, but the person sees the result and can change it.

## Provisional (stricter options, #159; Braden may change)
- **Replies do not switch.** `gmail_reply` / `outlook_reply_mail` show the From line but `switchable_to` is `[]` — a reply must come from the mailbox that holds the thread.
- **Switching is not a Yes.** It issues a fresh plan (new `preview_id` + `token`); the old token is consumed/revoked and can never execute.
- **From line is shown even with one mail account connected** (cheap, honest); the switch only appears with 2+.

## agent-core (t301a)
- `prepare_action` adds to each mail send/reply action:
  - `from_account`: `{"connector": "gmail"|"outlook", "label": "<ConnectorView.account label>"}`; label `null` when unknown (never guessed).
  - `switchable_to`: list of `{"connector", "label"}` for the OTHER connected mail connectors; `[]` for replies and when only one is connected.
- Both fields are inside the hashed canonical plan (token binds them).
- Account labels come from the connector status source (`GatesConnectorAdapter` / `ConnectorView.account`), threaded into `ChatService` explicitly; do not read them from model output.
- New websocket message (same socket as `confirm`): `{"type": "switch_account", "thread_id", "preview_id", "token", "action_index": int, "to_connector": "gmail"|"outlook"}`.
  - Validates like confirm (token must be valid, unused, not stale, for this thread/preview). On any failure: `{"type": "switch_account_error", "thread_id", "preview_id", "reason": "<short code>"}` and nothing changes.
  - `to_connector` must be in that action's `switchable_to`, else error `not_switchable`.
  - On success: revoke the old token, map the tool (`gmail_send` ↔ `outlook_send_mail`) with identical to/cc/bcc/subject/body, and send a fresh plan message exactly like `issue_plan` does (same `type` as today's plan message, new `preview_id` + `token`).
  - Logs one action-log line `plan_account_switched` (thread_id, from connector, to connector; no addresses/body).
- The send path executes the tool in the (possibly switched) plan; no other place may change the connector after issue.
- Version: agent-core 0.7.46, CHANGELOG entry, PR first line `**needs Braden**` (ask-first gate).

## desktop-app (t301d, after t301a merges)
- `PreviewCard` renders, per mail action with `from_account`: `From: <label> (<Gmail|Outlook>)` (label null → just the connector name).
- If `switchable_to` is non-empty: a small "Send from <Outlook> instead" control per option → sends the `switch_account` message; card shows a brief "Switching…" state, then the new plan replaces the card. Yes/No are disabled while switching.
- `switch_account_error` → the card stays, shows "Couldn't switch. Nothing was sent." and Yes/No work again on the old plan only if the error reason is not a token failure (token failure → old card becomes stale, same as today's stale handling).
- Screenshots (#293): one-account, two-account send (switch visible), reply (no switch), switching state.

## Mutation check (agent-core, before PR)
1. switch does not revoke the old token → a test must fail (old token confirm must be refused).
2. `from_account` left out of the hashed plan → a test must fail.
3. switch allowed on a reply → a test must fail.
4. switch accepts a stale/used/wrong token → a test must fail.
5. switched plan keeps the old tool (no mapping) → a test must fail.
6. `to_connector` not in `switchable_to` accepted → a test must fail.
