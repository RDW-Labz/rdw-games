# T27b contract — full recipients for reply-all (decisions #99, #106, #119)

Two parallel jobs, one contract. Names here are the only cross-repo names. Report any other name you needed in `crossJobNames`.

## connectors 0.4.6 (job rc-rcpt)

Reads (`graph_read.unread_mail`, `graph_read.search_mail`, `google_api.gmail_unread`, `google_api.gmail_search`):
- `MailHeader` gains three fields, last, with defaults so every existing constructor call stays valid:
  - `to_addresses: tuple[str, ...] = ()` — every To address, lower-cased, in message order, deduped.
  - `cc_addresses: tuple[str, ...] = ()` — every Cc address, same rules.
  - `account_address: str = ""` — the signed-in person's own address for that connector, lower-cased.
- Outlook: add `toRecipients,ccRecipients` to both `$select` strings. Account address: one `GET /me?$select=mail,userPrincipalName` per read call (use `mail`, else `userPrincipalName`); if that call fails, the read still succeeds with `account_address = ""`.
- Gmail: add `To` and `Cc` to the metadata headers fetched on reads; parse with `email.utils.getaddresses`. Account address: one `GET users/me/profile` per read call (`emailAddress`); failure → `""`, read still succeeds.
- Addresses only (no display names) in the two tuples. Never log addresses.

Writes (`graph_write.reply_mail`, `google_api.gmail_reply`):
- New keyword-only params `to: Sequence[str] | None = None`, `cc: Sequence[str] | None = None`.
- When `reply_all=True`: `to` is required and non-empty, else raise `ConnectError` with `kind="invalid"` before any network call. The sent message goes to exactly `to` and `cc` (`cc` None → empty).
  - Outlook: `createReply` (never `createReplyAll`) → PATCH the draft's `toRecipients` and `ccRecipients` to exactly these lists (plus the body as today) → send.
  - Gmail: use `to`/`cc` as the To/Cc headers instead of recomputing from `_reply_context`.
- When `reply_all=False`: behavior unchanged; `to`/`cc` ignored.
- Catalog: if `connector.yaml` lists tool args for `reply_mail` / `gmail_reply`, add `to` and `cc` (lists of strings, optional). Scopes unchanged (User.Read is already in outlook).
- Version 0.4.5 → 0.4.6: `pyproject.toml`, `src/gates/__init__.py`, `tests/test_smoke.py`, `uv.lock` (line with this project's version), `CHANGELOG.md`.
- PR first line: `**needs Braden**: reply-all write path sends exactly the preview's recipients (#119)`.

## agent-core 0.7.5 (job ar-rcpt)

Duck-typed: CI has no connectors wheel. Read the cached header (the per-turn `headers` mapping from `read_result`) with `.get()`; accept list or tuple for `to_addresses` / `cc_addresses`.

`ChatService.prepare_action` for `reply_mail` / `gmail_reply` with `reply_all` truthy (today this returns None unconditionally):
- Refuse (return None, as today) when: no cached header for that message this turn; `sender_address` missing; `to_addresses` or `cc_addresses` key missing (not list/tuple); `account_address` missing or empty.
- `self` = `account_address`, compared case-insensitively (strip + lower on both sides).
- To = dedupe([sender_address] + to_addresses) minus self, order kept. Cc = cc_addresses minus self minus anything already in To. If To is empty after that → refuse.
- The plan action's `content.to` and `content.cc` are these lists, every address spelled out; `content.reply_all = True`; `replying_to` as today. The summary names the counts only, e.g. `Reply all to <label> (+N others)`.
- `warnings`: the existing no-reply check runs over the new To and Cc.
- The plan hash covers the whole action (unchanged mechanism), so To/Cc are covered.
- Execution after Yes passes `reply_all=True, to=<content.to>, cc=<content.cc>` to the connector tool call. Non-reply-all replies unchanged.
- `chat_tools.py`: `reply_mail` / `gmail_reply` args stay `message_id body|reply_all` (the model never supplies to/cc; they come from the read).
- Logs (any `Log.record` / tool_log touching this path): counts only (`to_count`, `cc_count`), never an address.
- Decision #73: tool-result text (headers, addresses) never goes into the system message.
- Version 0.7.4 → 0.7.5: `pyproject.toml`, `src/anorak/__init__.py`, `src/anorak/chat_service.py`, `src/anorak/local_service.py`, `src/anorak/local_service_adapters.py`, `tests/test_local_service.py`, `tests/test_service_cli.py`, `uv.lock` line 7, `CHANGELOG.md`.
- PR first line: `**needs Braden**: reply-all preview + ask-first gate content change (#106, #119)`.
- The coordinator vendors connectors 0.4.6 into this branch after connectors merges; the job does not touch `vendor/`.

## Mutants the coordinator will run (write tests that kill them)
connectors: select missing ccRecipients; Gmail Cc header not fetched; account_address always ""; /me failure fails the read; createReplyAll used; Gmail recomputes Cc from context; reply_all allowed with no `to`; `cc` dropped on send; address logged.
agent-core: Cc dropped from preview; self kept in To; self compare case-sensitive; reply-all allowed without lists; reply-all allowed without account_address; empty To allowed; to/cc not passed at execution; address logged; header text moved into system (#73).
