# T27c contract — honest chat actions (P0, decision #120)

Two parallel jobs, one contract. Stacked on the T27b branches (connectors 0.4.6 `t27b-recipients`, agent-core 0.7.5 `t27b-reply-all`). Names here are the only cross-repo names; report any other in `crossJobNames`.

## connectors 0.4.7 (job gm-get)

- `graph_read.get_mail(person: str = DEFAULT_PERSON, *, message_id: str, client: httpx.AsyncClient, secrets: SecretsPort | None = None, catalog_dir: Path | None = None) -> MailHeader`
  - One `GET /me/messages/{quote(message_id, safe='')}?$select=id,subject,from,receivedDateTime,toRecipients,ccRecipients` (no body, no bodyPreview), plus the existing `_fetch_account_address` call.
  - Returns a `MailHeader` with `id`, `subject`, `sender`, `sender_address`, `received_iso`, `to_addresses`, `cc_addresses`, `account_address` filled exactly as `search_mail` fills them (same helpers).
  - `message_id` empty, over 512 characters, or with control characters → `ConnectError(kind="invalid")` before any network call. A 404 maps through the existing error mapping (not found). Audit uses the existing `read_mail` action (started / succeeded / failed).
- `google_api.gmail_get(...)` — same signature. Reuse `_fetch_message_headers` for the one id (its metadata headers already include To/Cc after 0.4.6) plus `_fetch_account_address`. Same validation.
- Catalog `can_do`: outlook adds `get_mail`; gmail adds `gmail_get`. Scopes unchanged.
- Never log a subject, body or address.
- Version 0.4.6 → 0.4.7: `pyproject.toml`, `src/gates/__init__.py`, `tests/test_smoke.py`, `uv.lock` (this project's version line), `CHANGELOG.md`; docs/graph-read.md and docs/google-api.md get a short section.

## agent-core 0.7.6 (job hc-honest)

CI has no connectors wheel; everything is duck-typed and tests use a fake dispatch.

1. **Re-fetch by id.** Before `prepare_action` for `outlook_reply_mail` / `gmail_reply`, the tool loop always calls the connector through the same dispatch the tools use: `get_mail` (outlook) or `gmail_get` (gmail) with `{"message_id": <the call's message_id>}`. The fetched header (converted to the same dict shape `read_result` caches) replaces any cached header for `"<connector>:<message_id>"` and is what `prepare_action` verifies. The turn's own reads no longer decide it. If the fetch raises, or the result has no `sender_address`, the call is refused with reason `REFUSAL_UNVERIFIED_RECIPIENT`. `get_mail`/`gmail_get` are NOT model-facing tools (not in the tool registry / schemas the model sees). The re-fetch counts as a read in the log (`chat_tool_read`, counts only) but not toward the search-first `reads_done` count.
2. **Visible refusal line.** Code-owned text, module constants in `local_service_adapters.py`:
   - `REFUSAL_UNVERIFIED_RECIPIENT = "Nothing sent: couldn't verify the recipient."`
   - `REFUSAL_GENERIC = "Nothing sent: {label} was refused."` (`label` = the tool's display label)
   Every do-tool refused in a turn adds its line, once each, at the top of the chat reply, then a blank line, then the (guarded) model text. The tool message the model sees for a refusal is `"Refused: nothing was sent. <reason>. Do not say it was done."`. The reply's note lists it: `Refused: <label> (not sent)`.
3. **Claim guard.** A chat turn never runs a do-tool (only the card's token does, via confirm). After the loop, if the final model text matches any of `CLAIM_PATTERNS` (case-insensitive, module constant):
   - `r"^\s*(?:all\s+)?(?:done|sent|replied)\b"`
   - `r"\bI(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:sent|replied|forwarded|moved|deleted|archived|scheduled|booked|created|cancel+ed)\b"`
   - `r"\b(?:has|have)\s+been\s+(?:sent|replied|forwarded|moved|deleted|archived|scheduled|booked|created|cancel+ed)\b"`
   - `r"\b(?:reply|email|message|mail)\s+I\s+(?:just\s+)?sent\b"`
   then the model text is replaced by code-owned text:
   - refused this turn → only the refusal line(s) plus `"Nothing was done."`;
   - else a preview card was made this turn → `CLAIM_PREVIEW_TEXT = "Here's the preview. Nothing is sent until you press Yes."`;
   - else → `CLAIM_NONE_TEXT = "Nothing was sent. Actions only run after you press Yes on a preview card."`.
   The stored thread message is the replaced text (so later turns never see the false claim). One `chat.claim_blocked` log entry: `{thread_id, patterns_matched: N, refused: N, preview: bool}` — never text.
   Patterns must not match third-person text like "you already replied to it" or "Darren sent you a message".
4. **Typed yes/no is not consent.** No code path may treat user text as approval. Test: an assistant offer, then the user types "yes" → at most a new preview card; `confirm`/execution never runs; the reply never claims done.
5. **Injection suite.** Two fixtures in `tests/fixtures/injection/`: `typed_yes_after_offer.json` and `refused_then_claims_done.json` (the 3:30 PM case: mail read in an earlier turn, follow-up question, user "yes", model calls the reply tool, model text "Done. Replied to Darren's message…"). With the re-fetch working, the second case previews; with the re-fetch failing, it shows `REFUSAL_UNVERIFIED_RECIPIENT` and no claim.
6. Decision #73: the person's own validated profile is config and belongs in system instructions; text from tool results, files the agent read, web pages, email or chat never does. Refusal lines and fetched headers never enter the system message.
- Version 0.7.5 → 0.7.6: `pyproject.toml`, `src/anorak/__init__.py`, `src/anorak/chat_service.py`, `src/anorak/local_service.py`, `src/anorak/local_service_adapters.py`, `tests/test_local_service.py`, `tests/test_service_cli.py`, `uv.lock` line 7, `CHANGELOG.md`.
- PR first line: `**needs Braden**: ask-first path change — reply re-fetch, refusal line, claim guard (#120)`.

## Mutants the coordinator will run
connectors: get_mail skips account address; get_mail selects bodyPreview; invalid id not refused before network; gmail_get skips To/Cc; can_do entry missing.
agent-core: re-fetch skipped (turn cache used); fetch failure still previews; get_mail exposed to the model; refusal line missing; refusal line only in note; claim guard off; one pattern dropped (each); stored thread keeps the claim; claim text replaced even when no pattern matches; typed "yes" runs confirm; refusal text in system (#73); re-fetch counted toward reads_done.
