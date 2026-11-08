# Bugcrowd submissions — staged drafts and the one remaining gate

Session 2026-11-07. Bugcrowd sign-in is now fully automated and every report below is typed
into its real submission form and saved server-side as a draft. Submission itself is blocked
by Bugcrowd's platform-wide **identity verification** (biometric: government ID + selfie,
processed by their vendor). That is the account owner's own step; the drafts are one click
away as soon as it is done.

| Program | Engagement | Draft id | Target | VRT | Reward ceiling |
|---|---|---|---|---|---|
| eToro | `etoro-mbb-og` | `b579ea10-02da-4320-b40c-eaa76292569f` | `*.etoro.com` | `server_security_misconfiguration.misconfigured_dns.subdomain_takeover` | $15,000 |
| Volkswagen | `volkswagen-og` | `5568e678-80f9-4c0d-b14a-cd3ccc6665f0` | `*.volkswagen.de` | same | $2,500 |
| EPAM | `epam-mbb-og` | `fb947741-703e-419b-870a-fac8322092ad` | `*.emakina.at` | same | $1,000 |

Draft URLs: `https://bugcrowd.com/engagements/<engagement>/submissions/<draft id>/edit`

## Do this once, then submit

1. `https://bugcrowd.com/h/settings/identity_verification` → *Start identity verification*
   (government ID + selfie; consent to biometric processing is the owner's to give).
2. Then, per program:
   `python3 engine/bc_submit.py submit <engagement> --report reports/out/<report>.md --target=<target> --url=https://<host> --vrt="Subdomain Takeover"`
   — or open the draft URL and press Submit.

## What was automated

- `engine/okta_login.py` — Okta identifier → password → TOTP (secret in
  `~/.config/rdwlabz/platform_secrets.json`, `chmod 600`) → OAuth back to bugcrowd.com.
  Prints only whether a secret is present, never a value.
- `engine/bc_submit.py` — opens the submission form, clears the agreement gate, selects the
  in-scope target by name, sets the VRT by real key events (the picker filters on keyboard
  handlers, so setting `.value` alone does nothing), fills caption / bug URL / description,
  ticks both consents, and saves a draft or clicks Submit.
- Hacker profile onboarding (name, bio, country, path steps) completed so the account is no
  longer dumped into `/h/onboarding`.

## Verified form state (read back from the saved drafts)

- eToro: caption "Subdomain takeover of candle-src.etoro.com via unclaimed Traffic Manager
  profile", description 4,174 chars, target `*.etoro.com`.
- Volkswagen: caption "Subdomain takeover of api.qa.whatsup.volkswagen.de via unclaimed Azure
  App Service name", 4,527 chars, target `*.volkswagen.de`.
- EPAM: caption "14 *.devweb.emakina.at hostnames dangle on two unclaimed Azure App Service
  names", 8,244 chars, target `*.emakina.at` (corrected from `*.emakina.ch`).
