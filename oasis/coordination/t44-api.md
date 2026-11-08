# T44 local API contract (agent-core ↔ desktop-app) — decisions #141, #161 (provisional)

## GET /connectors
Each tile object gains `"account": string | null` — the signed-in account label from the connector's own grant (connectors 0.4.10 `ConnectorStatus.account`). Plain text, ≤254 chars. `null` when not connected or unknown. Everything else in the tile is unchanged. (agent-core: when a connected tile has `account == null`, it schedules `gates.ensure_account` in the background once per run, never on the request path; the next poll shows it.)

## POST /connectors/{name}/disconnect  (a do action, ask-first; same shape as POST /chats/{id}/delete)
- Preview — body `{}`:
  - 200 `{"status":"needs_confirmation","preview":[line, …],"confirm_token":"<opaque>"}`
  - preview lines (fixed code-owned wording; `<Name>` = tile display name, `(<account>)` only when known):
    1. `Disconnect <Name> (<account>)?`
    2. per-connector effect line, e.g. Gmail/Outlook: `Beacon will stop seeing and sending mail there.`; calendars: `Beacon will stop seeing and changing your calendar there.`; Drive/OneDrive: `Beacon will stop seeing your files there.`; Teams: `Beacon will stop seeing your chats there.`
    3. `This forgets the sign-in on this computer. To remove OASIS from your Microsoft account, use its app settings.` (Google connectors: "Google account")
  - 404 `unknown_connector`; 409 `not_connected` (nothing stored).
- Confirm — body exactly `{"confirm_token":"<token>"}`:
  - 200 `{"status":"disconnected","result":"removed"|"already_gone"}`; the tile then reads Not connected.
  - 409 `confirmation_invalid` when the token is wrong, already used, from another connector, or the preview changed (account/state differ from preview time); 409 `paused` when the watcher is paused; 400 `invalid_body` for any other body shape.
- Token: single-use, bound to (connector name, person, digest of the preview lines). Preview never deletes anything. Tool/model text can never call this route (it is a local API route only; no chat tool maps to it).
- Audit: `connector_disconnected` with connector + result; never a token, grant or account text in the log or response.
