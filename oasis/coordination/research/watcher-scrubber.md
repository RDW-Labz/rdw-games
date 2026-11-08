# Watcher and scrubber for OASIS (2026-09-28)

Windows x64 first, then macOS, per #263. Research only — nothing here is built.

## Proxies

| Pick | License | Pin | What it's for | Link | Catch |
|---|---|---|---|---|---|
| mitmproxy | MIT | v12.2.3 (2026-05-12) | Local HTTPS MITM proxy; `request`/`response` Python addon hooks match T05's design exactly | [mitmproxy.org](https://mitmproxy.org/) / [docs](https://docs.mitmproxy.org/stable/overview/installation/) | CA install is one-time and needs admin (Trusted Root import, or the mitm.it in-browser page); Chrome won't trust a user CA for HTTP/3 QUIC (falls back to HTTP/2, harmless); apps that pin certs (banking, some Electron apps) fail closed unless bypassed per-app |
| HTTP Toolkit | Mixed: app shell AGPL, core `mockttp` lib Apache-2.0/MIT | rolling release | Friendlier UI over the same MITM idea, plus auto-intercept for Docker/Electron apps | [github.com/httptoolkit](https://github.com/httptoolkit/httptoolkit) | AGPL parts mean: use the shipped app unmodified only, never fork/embed its code; same Windows cert-trust step underneath as mitmproxy |
| OWASP ZAP | Apache-2.0 | 2.17.0 (2025-03-25) | Scriptable intercepting proxy with a REST API a Python watcher could drive | [zaproxy.org](https://www.zaproxy.org/) | JVM footprint is heavy for an always-on background watcher; scripting is Java/Groovy/Jython-first, Python only via the REST API, not in-process |
| proxy.py | BSD-3-Clause | 2.4.10 | Single-file pure-Python pluggable proxy; a from-scratch fallback | [pypi.org/project/proxy.py](https://pypi.org/project/proxy.py/) | No addon ecosystem or built-in cert-install UX like mitmproxy — we'd hand-roll CA trust and system-proxy toggling ourselves |

## Scrubbers

| Pick | License | Pin | What it's for | Link | Catch |
|---|---|---|---|---|---|
| detect-secrets | Apache-2.0 | v1.5.0 (2024-05-06) | In-process Python: `SecretsCollection` + a plugin API (regex + Shannon-entropy detectors) that maps directly onto T04's header/field rules | [github.com/Yelp/detect-secrets](https://github.com/Yelp/detect-secrets) | Built to scan files/diffs, not a live header dict — call its plugins per-field ourselves, skip its CLI/baseline flow; no published MB/s figure, benchmark against our own 200-trace set |
| Presidio (analyzer + anonymizer) | MIT | 2.2.364 (2026-07-22) | NLP-based PII detection (names, addresses, SSNs) beyond secret-looking tokens, for scrubbing email/company data, not just keys | [github.com/microsoft/presidio](https://github.com/microsoft/presidio) | spaCy NER model adds real per-request latency and misfires on common names; no published throughput number |
| gitleaks (rules, not the binary) | MIT | v8.30.1 (2026-03-21) | Mature, maintained regex+entropy rule set (AWS keys, tokens, etc.) to port as data into our own matcher | [github.com/gitleaks/gitleaks](https://github.com/gitleaks/gitleaks) | Gitleaks itself is a Go binary — "in-process" here means importing its TOML rules, not its code; project is now feature-frozen, successor is Betterleaks |
| scrubadub | MIT | 2.0.1 | Lighter pure-Python PII cleaners (email, phone, SSN, credit card) if Presidio's weight isn't needed | [github.com/LeapBeyond/scrubadub](https://github.com/LeapBeyond/scrubadub) | Built-in name detector is much weaker than Presidio's spaCy model, more misses on non-US name formats |

## Formats

| Pick | License/spec status | What it records | Holds arguments? | Link | Catch |
|---|---|---|---|---|---|
| HAR | Open JSON spec, W3C draft abandoned but a de facto standard | Full request/response entries (method, URL, headers, body, timing) | No — a flat snapshot, no constant/argument split | [w3c.github.io HAR](https://w3c.github.io/web-performance/specs/HAR/Overview.html) | No pause/ask-first or rollback concept; fits the raw-trace layer only, not a replayable macro |
| Playwright trace + codegen | Apache-2.0 | Browser actions (click/fill with named locators) plus linked network calls | No — codegen bakes in the recorded values, doesn't template them | [trace viewer docs](https://playwright.dev/docs/trace-viewer) | Browser-only, misses desktop apps like Outlook; closest "record once" shape but still a fixed script |
| Selenium IDE `.side` | Apache-2.0 | Browser UI steps as JSON, with named `${variable}` placeholders and pause commands | Yes, closest fit for arguments | [github.com/SeleniumHQ/selenium-ide](https://github.com/SeleniumHQ/selenium-ide) | Built for clicks/selectors, not raw HTTP calls; still no secret-scrubbing or ask-first, we'd add both |
| WebDriver BiDi logs | W3C spec, living Editor's Draft, royalty-free | A live event/log stream (console, network) over one standard protocol | N/A — it's a protocol, not a saved file | [w3c.github.io/webdriver-bidi](https://w3c.github.io/webdriver-bidi/) | Nothing to replay without building our own recorder/player around it first |
| Power Automate Desktop `.flow` | Proprietary (Microsoft) | Windows UI + browser steps with named input/output variables | Yes, already shaped like constants/arguments | [recording flows](https://learn.microsoft.com/en-us/power-automate/desktop-flows/recording-flow) | Closed format; unattended replay needs a paid Premium/RPA-add-on license per run |
| AutoHotkey `.ahk` | GPLv2 | Keystrokes/mouse moves as a real scripting language with variables | Yes | [autohotkey.com](https://www.autohotkey.com/) | GPL is usable only as an unmodified separate interpreter we shell out to, never embedded code; drives UI coordinates/keys, not HTTP calls, so it's the wrong layer anyway |
| UI Automation events (pywinauto/FlaUI) | pywinauto BSD-3-Clause; pywinauto-recorder MIT | Accessibility-tree events for any desktop app (not just browsers) | Partial — recorder emits a fixed Python script per run | [github.com/pywinauto](https://github.com/pywinauto/pywinauto) | Same problem as codegen: one fixed script per recording, and it captures UI structure, not the HTTP calls T06 needs to scrub and replay |

## Recommendation

**Proxy: mitmproxy.** MIT, and its `request`/`response` addon events are exactly what T05 already assumes. Catch: Windows still needs a one-time admin-elevated Trusted Root import (mitm.it makes this closer to click-through than most), and cert-pinned or Electron apps that hardcode a certificate need a per-app allow/bypass list rather than working out of the box — log them as "unseen: host" per T05, don't try to force them.

**Scrubber: detect-secrets, called in-process per field, not as a CLI.** Its plugin API (regex + Shannon entropy) is close enough to T04's own spec that we reuse the plugin logic instead of re-deriving entropy math, while T04 still owns the header/field allow-list and the "fails toward hiding" default. Add scrubadub only if free-text PII in bodies (names, emails) turns out to matter — skip Presidio's spaCy weight unless proven necessary; neither has a published MB/s figure, so benchmark both on the 200-trace fixture set before picking a default-on library.

**Format: keep T06's custom `.remote` YAML — adopt none wholesale.** None of the seven combine constants/arguments, `ask_first`, rollback and vault-sourced tokens the way T06 needs; Selenium IDE's `.side` and Power Automate's `.flow` come closest on "holds arguments" but are UI-step formats, not HTTP-call formats. Do adopt HAR's request/response entry shape for T05's raw scrubbed-trace file (before macro inference), since every browser devtool and proxy already speaks it and it costs nothing extra to emit. **Catch:** even this narrower adoption is a real commitment — it needs its own DECISIONS entry before T05 is built, per AGENTS.md's rule that a new format (or a borrowed one) is never silently assumed.

## Rejected

- **Fiddler Classic** — proprietary; as of 2026-08-03 restricted to non-commercial use only.
- **Charles Proxy, Burp Suite (Community)** — proprietary, paid tiers gate the features we'd need.
- **TruffleHog** — AGPL-3.0 since v3; rejected for in-process use. Usable only as an unmodified separate subprocess call, and even then its design (scan + live-verify credentials in git history) doesn't match "redact before any trace hits disk."
- **AutoHotkey (as a format)** — GPLv2 is fine only as an unmodified separate interpreter we shell out to, not embedded/adapted source; rejected as our macro format regardless, since it drives UI keys/coordinates, not HTTP calls.
- **Power Automate Desktop (as a format)** — proprietary, closed `.flow` spec, and unattended replay needs a paid license; not adoptable as our on-disk format.
```

This covers all four questions with links, verified licenses/dates, and a clear pick-plus-catch for each of proxy, scrubber, and format, noting that adopting HAR still needs its own DECISIONS entry.
