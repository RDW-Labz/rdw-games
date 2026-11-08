## 0.7.31

- T48 Mac-check fix, four issues found testing 0.7.30 on a real Mac:
  1. Teams-send guard now fires on the person's own turn text, before any
     model or tool call: any message pairing a send verb (reply, respond,
     answer, message, ping, write back, send, tell, "DM") with a Teams
     phrasing ("on Teams", "in Teams", "via Teams", "Teams message", "Teams
     chat") gets the fixed refusal as the *first* reply, in any word order,
     case-insensitively -- "Reply to Darren on Teams" no longer asks "which
     chat?" then reports a read failure. A non-send Teams question ("any new
     Teams messages?") is unaffected.
  2. A partial Teams (or other) read never leaves a "couldn't read"/"could
     not read"/"unable to read" claim standing once any data was actually
     read this turn -- the reply uses what was read and says it may be
     partial. A total failure (nothing read at all) still keeps the honest
     line.
  3. A recap's opening line is enforced in code, not only the prompt: at
     most 25 words, no heading, no leading count, and never the generic
     "Here's your recap" preamble -- when nothing in the model's own reply
     qualifies, a short, itself-qualifying generic line leads instead.
  4. Chat auto-titles now require 2-4 words total, at least 2 of them real
     subject words (not stopwords/filler like "how", "today", "casual",
     "check-in"): "How Today" and "Casual Check-in" no longer pass. The
     one-time retitle migration marker is bumped so every drawer gets one
     more pass under the new rule, still skipping any title a person chose
     themselves. A legacy index entry with no `auto_titled` key at all
     (pre-T48) is retitled the same way. The dated placeholder used when a
     chat's first message has no subject words at all reads "Chat, <Mon D>"
     (e.g. "Chat, Sep 28"), confirmed #260.

## 0.7.30
