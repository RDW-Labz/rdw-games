# T43 contract — formatted emails (decisions #139, #150)

## Shared shape
- The converter lives in agent-core: `anorak.email_format.render(markdown: str) -> RenderedBody(html: str, text: str)` (frozen dataclass). Input: the T41 safe Markdown subset (paragraphs, line breaks, `-`/`*` bullets, `**bold**`, `` `code` ``). Output html uses only `<p> <br> <ul> <li> <strong> <code>`, no attributes; every other `<`, `>`, `&`, `"`, `'` in the input is escaped as text; links stay plain text; `text` is the plain-text copy (bullets as "- ", bold marks removed), same words as html.
- agent-core passes BOTH to the connector for Outlook and Gmail send / reply / reply-all as keyword args `body` (= text, unchanged meaning) and new `body_html: str | None = None`. `body_html=None` keeps today's plain-text behaviour byte for byte.
- The ask-first card shows the exact `body_html` string that will be sent (hash-equal); T43 desktop half renders it without scripts or network.

## connectors (0.4.8 → 0.4.9)
- Outlook (Graph, `gates/graph_write.py` send_mail, reply_mail incl. reply_all): when `body_html` is given, the message body is `{"contentType": "HTML", "content": body_html}` (single body; Exchange makes the text copy, decision #150). Replies that today use a text `comment` must carry the HTML in the message body instead, with the same recipients/threading as today.
- Gmail (`gates/google_api.py` gmail_send, gmail_reply incl. reply_all): when `body_html` is given, build `multipart/alternative`: `text/plain` part = `body`, `text/html` part = `body_html` (UTF-8). Threading headers (In-Reply-To/References/threadId) unchanged.
- Connectors never build or alter HTML themselves: they send `body_html` as given (the converter is the only producer). They do not sanitize; they must not re-escape.
- Undo and the T34 write audit unchanged, except the audit entry records `format: "html"` or `"text"` (never the body).
- connector.yaml / catalog: declare the new optional `body_html` argument where the send/reply tools' arguments are declared.
