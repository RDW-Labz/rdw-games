# T27 follow-up contract (decision #114; Braden's T27 Mac check, 2026-09-25)

Two jobs, two repos, one contract. The Yes gate does not change.

## connectors 0.4.3 — structured mail search

`gates.graph_read.search_mail` and `gates.google_api.gmail_search` gain keyword-only filters. New signatures (everything else unchanged):

```
async def search_mail(person=DEFAULT_PERSON, *, query=None, sender=None, subject=None, after=None, before=None, limit=DEFAULT_SEARCH_MAIL_LIMIT, client, secrets=None, catalog_dir=None) -> MailSearch
async def gmail_search(person=DEFAULT_PERSON, *, query=None, sender=None, subject=None, after=None, before=None, limit=DEFAULT_SEARCH_LIMIT, client, secrets=None, catalog_dir=None) -> MailSearch
```

- `query`: free words (as today). `sender`: part of a name or address. `subject`: words in the subject. `after`: `YYYY-MM-DD`, on or after that day (UTC). `before`: `YYYY-MM-DD`, strictly before that day (UTC).
- At least one of the five must be non-empty after strip, else `ValueError("search needs at least one of query, sender, subject, after, before")`.
- `after`/`before` not a real date in `YYYY-MM-DD` → `ValueError("after and before must be YYYY-MM-DD")`; `after` ≥ `before` → `ValueError("after must be before before")`.
- `sender`, `subject`, `query`: at most 200 characters after strip, else `ValueError("search text is too long")`; allowed characters are letters, digits, space and `@ . _ - ' + ,`; anything else → `ValueError("search text has characters that are not allowed")`. (These values go into a search query string; the whitelist is the injection guard.)
- Outlook: build a KQL `$search` from the parts (`from:<sender>`, `subject:<subject>`, `received>=<after>`, `received<<before>`, plus the query words), quoting multi-word values the way Graph expects inside the existing escaped `$search="..."` value. Gmail: `q` = `from:(<sender>) subject:(<subject>) after:<YYYY/MM/DD> before:<YYYY/MM/DD> <query>` (only the parts given).
- Both: after the fetch, drop any message whose `received_iso` date falls outside `after`/`before` (belt and braces), and return messages **sorted newest first** by `received_iso`. `limit` rules and `MailSearch`/`MailHeader` fields are unchanged.
- Old call shape `search_mail(query="x")` keeps working.
- Version 0.4.2 → 0.4.3: pyproject.toml, src/gates/__init__.py, tests/test_smoke.py, uv.lock (gates package line only), CHANGELOG.md. No scope change.

## agent-core 0.7.2 — the chat uses it and stops asking

- `chat_tools.FIELDS`: `"search_mail": "|query sender subject after before limit"` and the same for `"gmail_search"`.
- `schema_for`: `after`/`before` → `{"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"}`; `sender`/`subject`/`query` → `{"type": "string", "maxLength": 200}`. `valid_arguments` enforces `pattern` and `maxLength` (today it may not; add it for every string property that declares them).
- Tool label/description for the two search tools (wherever `tool_label` gets its text): `Search mail by sender, subject, date range (after/before as YYYY-MM-DD) or words. Newest first.`
- New constant in `anorak/local_service_adapters.py`, exactly:

```
TOOL_USE_INSTRUCTIONS = (
    "When the person asks you to act on an email, event or file they describe loosely "
    "(for example \"reply to the latest one from my accountant\"), find it yourself with the read "
    "tools: search by sender, subject or date, pick the newest match, and prepare the "
    "action so the person sees the preview. Do not ask for details the preview will show; "
    "the preview and the person's Yes are the safety check. If they did not say what to "
    "write, draft a short, polite reply from the context; they can press No and tell you "
    "what to change. Ask a question only when nothing matches or you cannot tell which "
    "action they want."
)
```

- The tool loop's system message becomes `DEFAULT_CHAT_INSTRUCTIONS + "\n\n" + TOOL_USE_INSTRUCTIONS` (+ `"\n\n" + profile` when there is one, as today). The no-tools chat path is unchanged. Decision #73 stands: system text is only fixed code-owned wording plus the validated profile; tool results, summaries, mail text stay in their own labelled messages.
- Version 0.7.1 → 0.7.2 in every file asserting it: pyproject.toml, src/anorak/__init__.py, src/anorak/chat_service.py (two `skill_version=`), src/anorak/local_service.py, src/anorak/local_service_adapters.py (`version=`), tests/test_local_service.py (×2), tests/test_service_cli.py, uv.lock line 7, CHANGELOG.md. The coordinator swaps the vendored connectors wheel to 0.4.3 later; do not touch vendor/.
