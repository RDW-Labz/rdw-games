# Bugcrowd — Hacker API access request

Send via https://bugcrowd-support.freshdesk.com/support/home (Hacker / API access topic).
Fill the two bracketed fields before sending; nothing else needs editing.

---

**Subject:** Request Hacker API access + `write:draft_submissions` scope for account `[HANDLE]`

Hello Bugcrowd Support / Researcher Success,

I'd like to request access to the Hacker API for my researcher account.

- **Account:** `[HANDLE]` / `[EMAIL]`
- **API Credentials page:** the token I can generate at `bugcrowd.com/settings/api_credentials` exposes only a username/token pair and no scope selection, and the Hacker API rejects it at `https://hacker-api.bugcrowd.com/v1/engagements` with `401 invalid_token`.
- **What I need:** `read:engagement_list`, `read:submissions`, and `write:draft_submissions`, so that I can create submission **drafts** programmatically.
- **Why:** my findings come out of an automated recon pipeline (certificate-transparency and subdomain enumeration, DNS/CNAME resolution, host-side verification). Creating the draft over the API keeps the evidence, affected host list and reproduction steps byte-identical to the pipeline output instead of being re-typed into the web form, and it reduces transcription errors for the triage team.

Initial drafts I would file this way, both subdomain takeovers verified on the live DNS on 2026-11-01:

1. `epam-mbb-og` — dangling CNAMEs from `*.emakina.at` to released Azure App Service hostnames (14 hostnames, two targets NXDOMAIN).
2. `etoro-mbb-og` — dangling CNAME `candle-src.etoro.com` → released Azure Traffic Manager profile (target NXDOMAIN).

Two questions:

1. Is Hacker API access granted per account on request, and is there anything else you need from me to enable it?
2. Does `write:draft_submissions` require anything beyond the Hacker API access itself?

My identity verification status: `[VERIFIED / PENDING — confirm on the account]`. If verification is a prerequisite and something is outstanding on my side, please tell me what's missing.

Thank you,
`[NAME]`
`[HANDLE]` — Bugcrowd

---

## Notes for us (not part of the message)

- Docs confirm three prerequisites: account with Hacker API access, **verified identity** (otherwise `403 identity_not_verified`), and a token carrying the scopes above. `write:draft_submissions` is only offered *after* Researcher Success turns it on.
- Drafts only — `POST /v1/submissions?draft=true`. Final submission stays a human click in the UI by design.
- When access lands: put `user:token` in `~/.config/rdwlabz/bugcrowd_hacker.cred` (mode 600), then
  `engine/bc.py health` → `engagements` → `scope <id>` (fills `target`) → `draft reports/drafts/epam.json --apply`.
