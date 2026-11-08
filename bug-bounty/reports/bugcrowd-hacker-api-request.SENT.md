To: support@bugcrowd.com
Subject: Request Hacker API access + write:draft_submissions scope for account rdwlabz

Hello Bugcrowd Support / Researcher Success,

I'd like to request access to the Hacker API for my researcher account.

- Account: `rdwlabz` / jmacluer@gmail.com
- Credentials page: `https://tracker.bugcrowd.com/user/api_credentials` (app name "Hermes"). Generating a
  credential there returns only a Basic username/password pair plus an `Authorization: Token …` header,
  with no scope selection, and no way for me to pin a default API version for the new token.
- Result when I call the Hacker API with it:
  `GET https://hacker-api.bugcrowd.com/v1/engagements` -> `401 {"code":"invalid_token","detail":"Invalid API token."}`
  and the same token against `https://api.bugcrowd.com/submissions` -> `401 HTTP Basic: Access denied.`
  (tested both `Authorization: Basic <username:token>` and `Authorization: Token <token>`, with
  `Accept: application/vnd.bugcrowd+json`).
- What I need: `read:engagement_list`, `read:submissions`, and `write:draft_submissions`, so that I can
  create submission drafts programmatically.

Why: my findings come out of an automated recon pipeline (certificate-transparency and subdomain
enumeration, DNS/CNAME resolution, host-side verification). Creating the draft over the API keeps the
evidence, affected-host list and reproduction steps byte-identical to the pipeline output instead of
being re-typed into the web form, which removes transcription errors for your triage team.

Drafts I would file this way first, both subdomain takeovers verified against live DNS:

1. `epam-mbb-og` — dangling CNAMEs from `*.emakina.at` to released Azure App Service hostnames
   (14 hostnames, two targets NXDOMAIN).
2. `etoro-mbb-og` — dangling CNAME `candle-src.etoro.com` to a released Azure Traffic Manager profile
   (target NXDOMAIN).

Three questions:

1. Is Hacker API access granted per account on request, and is there anything else you need from me?
2. Does `write:draft_submissions` require anything beyond the Hacker API access itself?
3. My API credentials page shows an empty IP allowlist for the app ("Allowed IP ranges for Hermes" is
   blank). Does an empty allowlist deny all API calls, and if so what ranges should I add for a
   researcher working from a dynamic residential connection?

On identity verification: I completed HackerOne's identity verification on 2026-11-03. If Bugcrowd
requires its own verification before drafts are accepted, please tell me what is outstanding on my side.

Thank you,
Michael
`rdwlabz` on Bugcrowd

---
## Notes for us (not part of the message)

- Sent from security@rdwlabz.com via Resend to support@bugcrowd.com on the date in the file's git log.
- Docs confirm three prerequisites: account with Hacker API access, **verified identity** (otherwise
  `403 identity_not_verified`), and a token carrying the scopes above. `write:draft_submissions` is only
  offered *after* Researcher Success turns it on.
- Observed 2026-11-03: a 72-char token minted at tracker.bugcrowd.com gives `invalid_token` on
  `hacker-api.bugcrowd.com/v1` and `HTTP Basic: Access denied.` on `api.bugcrowd.com`. A 44-char (32-byte)
  token minted earlier behaved the same on hacker-api but returned 200 on `api.bugcrowd.com/{submissions,
  programs,engagements}` — so the platform surface accepts the older credential generation only.
- When access lands: put `user:token` in `~/.config/rdwlabz/bugcrowd_hacker.cred` (mode 600), then
  `engine/bc.py health` -> `engagements` -> `scope <id>` (fills `target`) -> `draft reports/drafts/epam.json --apply`.
