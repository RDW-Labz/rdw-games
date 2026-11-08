# T27 search-first contract (decision #118, Braden 2026-09-25)

One repo: agent-core 0.7.3 → 0.7.4. Orchestrator merges (no gate, secret, scrubber or update-path change; the Yes gate is untouched).
Braden's choices: prompt + code guard; CI tests with a scripted fake model plus one live eval (opt-in); tool-call cap 6 → 10.

## 1. Tool-call cap

- New constant `TOOL_CALL_LIMIT = 10` in `anorak.local_service_adapters`. It replaces every literal `6` that caps tool calls per turn: the `call_limit` defaults and `min(6, ...)` in `local_service_adapters.py`, and `call_limit=6 - model_calls[0]` in `local_service.py`.
- Existing tests that assert six calls / "no seventh" are updated to ten / "no eleventh" (same shape).

## 2. TOOL_USE_INSTRUCTIONS (exact text, replaces the #114 text)

```
When the person asks you to find or act on an email, message, event or file they describe loosely (for example "reply to the latest one from my accountant"), find it yourself with the read tools. Before you ask the person anything, try at least three searches yourself: every connected mail account (Outlook and Gmail), a plain-text search for the name when a sender search finds nothing (notifications from Teams and other apps come from no-reply addresses and name the person only in the text), name variants (first name, full name, likely spellings), and the other connected tools (Teams chats, calendar, notes). Then pick the newest match and prepare the action so the person sees the preview. Do not ask for details the preview will show; the preview and the person's Yes are the safety check. If they did not say what to write, draft a short, polite reply from the context; they can press No and tell you what to change. Never ask for a subject line, a date or an id the person would not know. If you still need them, say in one line what you searched and what you found, then ask at most one question. For example: "No email from Darren in Outlook or Gmail. There's a Teams notification about a message from him at 11:02; want me to read that chat?"
```

Still appended to the tool loop's system message only (never the no-tools path), exactly as today.

## 3. Search-first guard (code, in the tool loop)

In `LoopModelChatAdapter.tool_turn`'s loop, when the model returns final text with no tool calls:

- `questions` = number of `?` in the text after removing URLs (`https?://\S+`).
- `reads_done` = number of read-kind tool calls run this turn (each call counts once, whatever it returned).
- `reads_needed` = `min(3, number of read-kind tools offered this turn)`.
- Fire the guard when `questions >= 1 and reads_done < reads_needed`, or when `questions > 1`, and only if it has not fired yet this turn and at least one more tool call is allowed under the cap.
- Firing: do not return the text. Append the model's text as an assistant message, then a **user-role** message with exactly `SEARCH_FIRST_NUDGE` (below), and continue the loop. It fires at most once per turn; the next final text is returned as it is, whatever it contains.
- `SEARCH_FIRST_NUDGE` (constant in `local_service_adapters`, exact text):
  `OASIS check (not from the person): before asking, search yourself. Try every connected mail account, a plain-text search for the name, name variants, and Teams, calendar or notes. Then reply with one line on what you searched and what you found, and ask at most one question.`
- The nudge and the rejected draft are never stored in the chat thread, never shown to the person, and never go in the system message (#73: system text stays fixed code wording + the validated profile; tool results stay labelled tool messages).
- Log one `chat.search_nudge` activity entry when it fires (reads_done, reads_needed, questions — counts only, never text).

## 4. Tests

New `tests/test_chat_search_first.py` (scripted fake model and fake connectors, like `tests/test_chat_tool_loop.py`; CI has no connectors wheel, so fake `gates` in `sys.modules`; never reload anorak modules):

Fixture `tests/fixtures/chat/darren_teams_notification.json` (fake data, example.com only):
- Outlook `search_mail(sender="Darren")` → no messages. Gmail `gmail_search(sender="Darren")` → no messages.
- Outlook `search_mail(query="Darren")` → one message: sender "Microsoft Teams", sender_address `noreply@email.teams.example.com`, subject "Darren sent you a message", received_iso `2026-09-25T16:02:00Z` (11:02 in US Central), preview "Darren: are you around?".
- `teams_recent_chats` → one chat with "Darren" (chat_id `chat-darren`, last message 11:02).

Cases:
1. Darren case: the model first answers "What's the subject line?" after one read → the guard fires; the model's next request holds the nudge as a user-role message and the unchanged system message; the model then calls gmail_search, search_mail(query), teams_recent_chats and answers the reference line → the returned reply is the reference line; the stored thread has the person's message and that reply only.
2. After three reads, a one-question reply passes with no nudge.
3. Two questions after three reads → one nudge; if the next answer still has two questions it is returned as is (fires once).
4. No read tools offered except notes_read and one notes_read call made → no nudge (reads_needed = 1).
5. No question in the text → no nudge, even with zero reads.
6. Cap: ten tool calls run, the eleventh is not.
7. #73: no fixture text and no nudge text in the system message; the nudge is role user, tool results role tool.
8. The `chat.search_nudge` log entry has counts only.
9. TOOL_USE_INSTRUCTIONS equals the exact text above.

Live eval `test_live_chat_searches_before_asking` in the same file, skipped unless `OASIS_LIVE_CHAT=1` (same model-route pattern as `test_live_chat_speaks_to_the_person_in_second_person` in `tests/test_chat_profile.py`), fake connectors with the Darren fixture. Asserts: at least three read calls before the final reply; the reply mentions Outlook, Gmail and Teams; at most one `?`; it does not ask for a subject or a date (no match for `(?i)(what|which).{0,20}(subject|date)`).

## 5. Version

0.7.3 → 0.7.4 in: pyproject.toml, src/anorak/__init__.py, src/anorak/chat_service.py ×2, src/anorak/local_service.py, src/anorak/local_service_adapters.py (`version=`), tests/test_local_service.py ×2, tests/test_service_cli.py, uv.lock line 7, CHANGELOG.md.
