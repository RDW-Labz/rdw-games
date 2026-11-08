# Write APIs for OASIS (2026-09-28)

## QuickBooks Online

| Topic | Fact | Source | Date |
|---|---|---|---|
| Sandbox count | Up to 10 sandbox companies per developer account | developer.intuit.com/.../sandbox-faqs | checked 2026-09-28 |
| Sandbox reset | Sample data can't be reset in place; delete the company and start over | help.developer.intuit.com Sandbox Companies topic | checked 2026-09-28 |
| Sandbox email cap | 40 test emails/day from a sandbox company | developer.intuit.com sandbox-faqs | checked 2026-09-28 |
| Access token lifetime | 1 hour | help.developer.intuit.com/s/article/Handling-OAuth-token-expiration | checked 2026-09-28 |
| Refresh token (current) | ~100 days, rolling, value can change on each refresh | help.developer.intuit.com/s/article/Validity-of-Refresh-Token | checked 2026-09-28 |
| Refresh token (incoming policy) | Moving to a 5-year max with rotation; refresh response will carry an expiry field; first expiries Feb 2027 (granular scopes) / Oct 2028 (accounting/payments scope) | blogs.intuit.com "Important changes to refresh token policy" (Intuit Developer, Medium) | 2025-11-12 |
| Redirect URI, production | Exact match only, up to 25 URIs; **no localhost, no custom URL scheme** (e.g. `myapp://`) allowed | help.developer.intuit.com Q&A "Why does Production Redirect URI not allow localhost"; developer.intuit.com Set-app-redirect-uri | checked 2026-09-28 |
| Redirect URI, sandbox/dev keys | localhost allowed only on the Development keys tab, not Production | help.developer.intuit.com same threads | checked 2026-09-28 |
| PKCE | Not documented or required by Intuit; flow is plain OAuth 2.0 Authorization Code with a client secret | developer.intuit.com Set up OAuth 2.0 | checked 2026-09-28 |
| Write scope | `com.intuit.quickbooks.accounting` covers create/update of invoices, bills, journal entries and most accounting objects | developer.intuit.com Accounting API overview | checked 2026-09-28 |
| Rate limit, standard | 500 requests/min per realm, 10 concurrent requests/sec per realm | help.developer.intuit.com/s/article/QuickBooks-Online-API-Best-Practices | checked 2026-09-28 |
| Rate limit, resource-intensive endpoints | 200 requests/min | same Best Practices article | checked 2026-09-28 |
| Rate limit, batch endpoint | Throttled separately; sources disagree (40/min vs 120/min) — **re-verify against the live account before relying on a number** | Best Practices article + conflicting third-party guides (Coefficient, Satva) | checked 2026-09-28 |
| Throttle error | HTTP 429, error code 003001 `ThrottleExceeded` | Best Practices article | checked 2026-09-28 |
| Idempotency | `RequestId` query param on write calls; a repeat with the same id returns the original response instead of duplicating; **no published retention window**, don't retry immediately while the first call may still be in flight | help.developer.intuit.com/s/article/What-is-RequestId-and-its-usage | checked 2026-09-28 |
| minorversion | Versions 1-74 deprecated 2025-08-01; unpinned requests now default to v75 | developer.intuit.com Minor versions page; Medium "Changes to our Accounting API" | 2025-08-01 |
| Production keys, private/in-house app | An unlisted app skips the marketplace technical/security review but must still pass Intuit's "app assessment questionnaire" before production keys are issued; no marketplace listing required | help.developer.intuit.com "How to get Production Keys for a private app" + "New app assessment process FAQ" | checked 2026-09-28 |

## Teams send (Graph)

| Topic | Fact | Source | Date |
|---|---|---|---|
| Send 1:1/group chat message | Delegated scope `ChatMessage.Send` (least-privileged); work/school accounts only, personal Microsoft accounts not supported | learn.microsoft.com Send message in a chat | updated 2026-05-19 |
| Send channel message | Delegated scope `ChannelMessage.Send` (least-privileged) | learn.microsoft.com Send chatMessage in a channel | checked 2026-09-28 |
| Admin consent | Both `ChatMessage.Send` and `ChannelMessage.Send` require tenant admin consent | graphpermissions.merill.net permission pages | checked 2026-09-28 |
| Higher-privilege fallback | `Chat.ReadWrite` / `Group.ReadWrite.All` also work but grant far more than send | learn.microsoft.com Send message in a chat | checked 2026-09-28 |
| Application (non-user) permission | Only `Teamwork.Migrate.All`, for data-migration scenarios; **application permissions are not supported for normal sending** | learn.microsoft.com same page | checked 2026-09-28 |
| Edit a sent message | Needs the broader `Chat.ReadWrite` (chat) or `ChannelMessage.ReadWrite` (channel) — not covered by the Send scope alone; fails for Skype-interop chats; no federation support | learn.microsoft.com Update chatMessage | checked 2026-09-28 |
| Delete a sent message | Soft delete only; "Owners can delete sent messages" is Off by default tenant-wide, needs a custom Teams messaging policy to turn on for anyone but the original sender | learn.microsoft.com chatMessage softDelete; Microsoft Q&A thread | checked 2026-09-28 |
| @mentions | Supported via a `mentions` array plus `<at id="n">Name</at>` markup in the HTML body | learn.microsoft.com chatmessage-post examples | checked 2026-09-28 |
| Message format | `body.contentType` is `text` or `html`; Teams client strips/ignores some HTML (arbitrary `<div>`, inline styles) | learn.microsoft.com chatmessage-post | checked 2026-09-28 |
| Throttling | Service-specific Teams limits apply per app+tenant (roughly 20 rps class for chat/channel posts) plus a hard **1 request/sec per user per chat or channel**; exact published numbers shift release to release | learn.microsoft.com Graph throttling-limits, Teams service limits section | checked 2026-09-28 |
| Terms of use | Teams may not be used as a log; only send messages a person will actually read | learn.microsoft.com chat-post-messages notes | checked 2026-09-28 |

## Redesign quirks

1. **QBO production forbids the loopback pattern we already built.** T11's connect flow opens the consent page and receives the callback on `127.0.0.1` — QBO's production redirect URI must be a real HTTPS endpoint; no `localhost` and no custom URL scheme. (help.developer.intuit.com Q&A; developer.intuit.com Set-app-redirect-uri; docs/TICKETS.md T11)
2. **Current admin consent doesn't cover Teams send.** T03's granted delegated scopes are Mail.Read, Mail.Send, Calendars.ReadWrite, Files.Read.All, Sites.Read.All, Chat.Read, User.Read — no `ChatMessage.Send` or `ChannelMessage.Send`. Teams send needs a fresh admin-consent round before any code runs, matching decisions #97/#98's "scopes widened" note. (docs/TICKETS.md T03, T27; Graph permission docs)
3. **QBO refresh tokens are mid-migration.** Today's ~100-day rolling refresh token is being replaced by a 5-year token with rotation and a published expiry field, rolling out per-scope in 2027/2028. Code that assumes "refresh forever without re-consent" will silently break at the 100-day mark until an app is migrated. (Intuit Developer blog via Medium, 2025-11-12)
4. **Send scope isn't edit/delete scope.** T27's planned Undo feature (#102) can't reuse the send-only grant for Teams — editing needs `Chat.ReadWrite`/`ChannelMessage.ReadWrite`, and deleting someone else's message needs a Teams admin policy change, not just an API scope. (learn.microsoft.com Update/softDelete chatMessage)
5. **QBO minorversion has a hard cutoff.** Versions 1-74 were dropped 2025-08-01; an integration that never pins `minorversion` silently rides Intuit's current default and can break on the next schema change. (developer.intuit.com Minor versions)
6. **QBO batch/rate numbers conflict across sources** (40 vs 120 requests/min for the batch endpoint). Building sync or bulk-write logic on an unverified number risks live throttling; confirm against the actual production account before depending on it. (Best Practices article vs. third-party guides)
7. **Teams application (unattended) sending is not a simple permission swap.** App-only permissions for chat/channel send are restricted to `Teamwork.Migrate.All` migration scenarios; a later move away from delegated "send as the signed-in user" needs a different design (bot framework or resource-specific consent app), not a bigger scope. (learn.microsoft.com Send message in a chat)

## Recommendation

**QuickBooks Online:** use the OAuth 2.0 Authorization Code flow as a private, in-house app (no marketplace listing) against one production realm; put `RequestId` on every write call from day one; pin `minorversion` explicitly. Because production forbids loopback redirects, front the flow with a small hosted HTTPS callback (e.g. under `cluerholdings.com`) that hands the code back to the desktop app, rather than reusing T11's `127.0.0.1` pattern as-is. **One test before building on it:** complete a full OAuth round trip against the real sandbox company and create one test invoice using a `RequestId`, confirming token exchange, the write scope, and idempotency all behave as documented.

**Teams send (Graph):** keep the same delegated, signed-in-user Authorization Code flow already used for Outlook; add `ChatMessage.Send` and `ChannelMessage.Send` to the existing Entra admin-consent grant (a new consent step, not a code change). **One test before building on it:** after the admin grants the new consent, send one real chat message and one real channel message as the signed-in test user in the tenant, and confirm both post without hitting the per-user-per-thread throttle.
