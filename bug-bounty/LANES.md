# Lane registry — what is measured, what is dead, what is left

Every automated lane in this repo has now been run against the real corpora and the yield recorded.
The point of this file is to stop the next session (human or agent) from re-opening a lane on the
strength of how it *sounds*. A lane is only worth automating once its measured yield per 100 hosts
beats the cost of the automation, and three of the four "obvious" lanes do not.

Corpora: **541,926 hosts** across **34,353 domains**; **43,365 scope rows** across **909 programmes**
(HackerOne + Bugcrowd + Intigriti + YesWeHack).

## Measured

| Lane | Script | Automated | Measured yield | Verdict |
|---|---|---|---|---|
| Dangling-CNAME takeover, paying scope | `dangling.py`, `verify_claimable.py` | cron, every 15 min | 541,926 hosts → 33 "claimable" → 2 → **0 inside a paying published asset**. 2 reports filed, both closed `informative`, **$0** | **Dead** as a bounty lane |
| Leaked credentials in live JS bundles | `jsscan.py` | runnable headless, no cron | 420 paying-scope hosts, **188 pages answered 200**, 5 candidates, **0 exploitable**. All hits `pk_live_`, Firebase web, Supabase `anon`, one config JWT | **Dead**; keep as hygiene only |
| Leaked credentials in **archived** JS | `wayback.py` | runnable headless, no cron | 34 hosts, 31 bundles fetched (up to 40/host), **0 secrets**; 21-49 fetches per pass were dead captures or un-followed redirects until fixed | **Dead** |
| Leaky archived paths (`/.git/`, `/.env`, `*.sql`, `*.bak`) | `wayback.py` | same run | 300 archived URLs sampled per host, **0 matches** across 34 hosts | **Dead** |
| Cloud-bucket references in bundles | `wayback.py` | same run | **0** | Parked |
| Takeover inventory **outside** any programme (the saleable set) | `leads.py` | runnable headless | 4,402 dead CNAME records → **35** companies with no published programme → 46 still dangling on live re-check → **2 claimable** (both `*.trafficmanager.net` at stewart.com) | **One lead**, not a business |
| Cold outbound offer to companies with dead records | `send_offers.py` | cron follow-up every 6 h | **16 sends, 0 replies** | Not enough volume to falsify — 16 sends cannot distinguish a 2 % lane from a 0 % lane |
| Breadth census: 14 fixed exposure paths | `census.py` | runnable headless | 3,000 sampled in-scope hosts → **655 answered** (159 catch-all SPA shells discarded) → 9,170 probes → **19 signature-confirmed hits**: 10 `crossdomain.xml`, 6 "swagger", 1 `openapi.json`, 1 `wp-json` users, 1 `actuator/health`. **`.git/config`, `.env`, `.DS_Store`, `.svn`, `phpinfo`, `actuator/env`, `debug/vars`: 0/655 each** | **No payable class at this depth** |
| API docs → open endpoints | `apispec.py` | runnable headless | 7 doc hits → 2 had a real spec (moonpay, 20 paths, 3 parameterless GETs) → **0 endpoints answered unauthenticated**. The other 5 "swagger" hits are false positives: the signature word appears in the page, no spec exists | **0** |

The JS numbers are the important ones: they were produced *after* fixing the three failures that make
a scanner silently report zero — a bot `User-Agent` drawing `403`, `http.client` not following
redirects, and a `.js`-only filter dropping `*.webpack` and hash-named bundles. Before those fixes the
same scan reported 0 hits on hosts that plainly had bundles. Any future zero should be read as
"0 hits / 0 pages = broken fetch" until the answered-page count says otherwise.

## What the measurements actually say

Automated discovery on **someone else's** assets is exhausted here. It is not that the tooling is
bad; it is that the population has been picked over by every scanner on earth, and the classes that
still pay (a chain, a business-logic flaw, an authorization gap) need a human reading one application
closely. The corpus is a good *opening move* — it tells you which hosts exist — and a poor *closing
move*.

So "headless" has to mean something other than "sweep more hosts":

1. **Audit-on-demand for a named domain.** `audit.py` already turns the DB into a client-ready
   markdown + CSV deliverable. Proven end to end: `engine/audits/audit-stewart.com_*-2026-11-04.md`
   — 1,700 hosts, 3 dead records, 2 claimable, remediation checklist. This is the only artifact in
   the repo somebody would pay for, and it is produced without a single interactive step. Its
   bottleneck is not scanning, it is a list of names that owns domains, which outbound has to earn.
2. **Content and benchmarks on the rig.** Reproducible numbers, published, are the only headless
   channel that compounds into standing — and standing is what unlocks private programmes, which is
   where the bounty money actually is. This converts compute into reputation instead of into more
   dead-end findings.

## The payable things found this cycle

`api.qa.whatsup.volkswagen.de` → `whatsup-backend-qa.azurewebsites.net` (NXDOMAIN from 1.1.1.1,
8.8.8.8, 9.9.9.9), inside Bugcrowd **Volkswagen** `*.volkswagen.de`, bounty-eligible, P4–P3
($150–$600, and VW states it pays non-prod systems less). Draft: `reports/bc-Volkswagen-dangling-cname.md`.

Worth filing *because the scope row is real*, not because the class is hot — it is the only in-scope
dangling record the fastcheck found in 4,402 dead edges.

`shm-playground.playticorp.com` → `playtika.github.io`, inside HackerOne **playtika** `*.playticorp.com`.
Stronger than the VW one: `github.com/playtika` 404s (the Pages name is registrable), the host answers
GitHub's `pages/auth` redirect for `page_id=48972994`, and GitHub still terminates a valid Let's Encrypt
certificate for the hostname — proof a Playtika Pages site lived there and its account is gone. Draft:
`reports/h1-Playtika-dangling-cname.md`. The one open question is whether to spend a few minutes
registering the username for a screenshot before filing.

## The two leads that looked payable and were not

All three arrived from the cron inside a day, and all three were the same error — acting on a single
cheap sample of one end of the record.

| lead | why it looked real | what killed it |
|---|---|---|
| `heosdiagnostics.denon.com` → `app-prd-sun-uw1-win-heos.azurewebsites.net` | NXDOMAIN target, brand domain belongs to HARMAN | Harman's published scope is 67 assets on harmanaudio.com / harmankardon.com and **zero** on denon.com. The old cron joined on the brand domain, so it printed a programme name that does not cover the host |
| `www.audiotour.karwei.nl` → `karwei.netlify.app` | in scope (`*.karwei.nl`, Intigriti/intergamma) and the host answered Netlify's "site not found" | `karwei.netlify.app` is a live site the owner controls. The host 404s only because that custom domain was never attached to the site. Claimability lives at the *platform name*, not at the custom host |
| `chordplayer.spotify.net` → `chordplayer.netlify.com` | in scope (`*.spotify.net`, HackerOne/spotify) and the target name answered Netlify's 404 three times | the host itself serves a 200 with a live React app — the domain is bound to a site that exists, and the `.netlify.com` alias is simply not that site's canonical name. The mirror of the Karwei case: one end free, the other end served |

So `engine/leadgate.py` gates all three questions before the cron is allowed to shout: `covered(host)`
matches the published scope **asset** (never a brand domain); `unclaimed(target)` re-asks the platform
three times, spaced, about the name that can actually be claimed, including GitHub's owner-liveness
check; and `serves_content(host)` refuses to call a record dangling while the host itself still serves a
real page. `fingerprint.py` now probes
the target instead of the host and demotes a single 404 to `UNSTABLE` if the next look disagrees —
a deploy in progress is not a takeover.

Current verdicts: VW file, Karwei live, HARMAN unpaid.

## Revenue lanes (not recon)

The recon lanes above all end in a report. These two start from the fact that a report is not money and
a signed agreement is not money either, and they exist because both were believed to be true this week
when neither was.

| Lane | Script | What it owns | Measured |
|---|---|---|---|
| The tally nobody can argue with | `money.py` | reads `outreach/sent.json`, `reports/esign/*.json`, `reports/filed.json` + the live HackerOne API, `state.db`; prints collected / signed-unpaid / offers / claims with live state | **$0 collected**, 2 claims filed → **both closed `informative`**, 16 offers to **14 organisations** = $21,000 asked, **0 replies** |
| E-signature intake | `esign.py` | turns an envelope (text, PDF, or just a URL) into `reports/esign/<slug>.md` — what we get, what we give up, what they owe, and the operator's five steps — plus the JSON `money.py` counts | Celemi reward agreement ingested as a URL-only stub: the document itself is behind a Docusign access code and **the Gmail lane is dead** (`invalid_grant`), so nothing could be extracted |

The number that matters: the register said "Claims filed 2" and listed GitHub as `new` while HackerOne
had closed it `informative` six days earlier. A tally assembled from notes drifts from the platform.
`money.py` re-asks the platform every run, and that is the only reason the `informative` was found.

**The mail lane is the actual bottleneck, not the research.** Gmail via
`skills/productivity/google-workspace/scripts/google_api.py` raises `invalid_grant: Bad Request` — the
OAuth refresh token is dead, so no access code, no Docusign link, no reply detection can be read
headlessly. Re-auth once (`google_api.py` interactive flow) and both of the above stop needing a human
in the middle.

`tools/mail_search.py` is the lane that does work — it drives the operator's own signed-in Firefox
profile (`mail_read.refresh_profile()` each run), so it sees live mail for `jmacluer@gmail.com` *and*
mail addressed to `security@rdwlabz.com` (Bugcrowd tickets land there and are searchable). Use it for
reset links and replies; do not reach for the OAuth script.

### Intigriti is locked out — and not for a reason a retry fixes

Recorded so no future run burns an hour re-deriving it:

- `login.intigriti.com/account/login` is **two-step**: `#Input_Email` → *Next* → password. A cookie
  banner sits over the form and eats the first *Next* click, which reads exactly like a bad password.
  `engine/browser_login.py okta <platform>` now dismisses it first — use that mode for Intigriti.
- The stored `intigriti` password in `~/.config/rdwlabz/platform_secrets.json` is rejected
  (*"Login failed, please try again"*) for every address we have.
- `tools/h1_password.py --site intigriti --request [--email …]` runs the reset flow (the *Forgot your
  password?* link only renders on the **password** step, so the email must be submitted first). It
  reaches *"We have sent you a reset mail"* for both `security@rdwlabz.com` and `jmacluer@gmail.com`,
  and then **no Intigriti mail ever arrives**: zero hits for `intigriti` in `in:anywhere`, `in:spam`,
  and default search, checked repeatedly out to ~10 minutes after the request. The readable Gmail
  lane is otherwise demonstrably live in that window.
- What that means: the address Intigriti holds is a mailbox this lane cannot read, or the platform's
  mail is not being delivered at all. The fix is one of two human steps — point the operator at the
  mailbox the account was registered on, or mint an Intigriti API token under *Settings → API* and put
  it in the vault. Neither can be automated from here.
- Separately, Intigriti releases **no reward** until the researcher passes identity verification, so
  filing there is worth doing only once that is done (`PLATFORMS.md`).

## Rules for adding a lane

- No new sweep without a written expected-yield estimate and the corpus size it applies to.
- Every zero must print its denominator (pages answered, bundles fetched, records checked).
- A lane that pays $0 after one honest measurement gets its cron disabled, not another parameter.
- Never point a lane at a target whose policy is unknown; `scopes` is the gate, not a suggestion.
