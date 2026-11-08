# Standing up the four platform accounts

**The division of labour, and why it is this way.** I can prepare every field, every document and every
follow-up, but I will not create these accounts myself: a signup means typing a password into a login
form, and the rules I run under forbid this tool from typing passwords, card numbers or one-time codes
— no matter who gives permission, because the same rule protects you the day something impersonates
you in a session. HackerOne's Veriff step is also biometric (ID + selfie), and three of the four send an
SMS or code. Those are yours by design, not by my reluctance.

What I have already done: the identity is settled, the mail address exists and is company-branded, and
four strong passwords plus the exact field values are in `~/.config/rdwlabz/platforms.json` (mode 600,
outside the repo). Print one when you need it — never in a transcript:

```bash
python3 engine/vault.py show bugcrowd          # username candidates + password
python3 engine/vault.py get  bugcrowd password | xclip -selection clipboard
python3 engine/vault.py set  bugcrowd status=created username=<what you got>
```

## The identity you will type, once, everywhere

| Field | Value |
|---|---|
| Legal name | **RDW** |
| Trading / display name | **RDW Labz** |
| Entity type | U.S. corporation / LLC — match the W-9 |
| Jurisdiction | Arkansas, United States |
| Address | 601 US-62 65 S., Harrison, AR 72601, US |
| Email | security@rdwlabz.com |
| Website | https://rdwlabz.com |
| Phone | **yours to enter** (I will not invent one) |
| EIN | **yours to enter**, only into the platform's W-9 field |

Same entity from the first report. Every platform below either prohibits or makes painful a later move
of an account or its payouts to a different legal person, and a track record carrying RDW's name from
report one is worth more than the hour this saves.

## 1. HackerOne — `https://hackerone.com/sign_up`

Largest pool we index (450 programmes, 219 paying). Full sequence is in `RUNBOOK-payout-setup.md`:
signup → **self-identify as a business** (legal name RDW, Arkansas, trading name RDW Labz) → Veriff as
authorised representative → company payment method (name must match the W-9) → corporate W-9 with the
EIN. A submission earns nothing until all three show green.

## 2. Bugcrowd — `https://bugcrowd.com/user/sign_up`

The one with no account today and the best economics: 292 of 297 listed programmes pay, 189 publish a
cap of $2,000+. Order matters — add the payout method first (bank transfer, 1–2 business days; or
PayPal, same day), then submit the tax form: a U.S.-incorporated entity files **W-9**; the substitute
form takes the business name in the *Business Name* field, or upload a completed W-9 instead.
Splitting a payout across collaborators is only possible *before* submission, so there is no later fix.

## 3. YesWeHack — `https://www.yeswehack.com/login`

Small pool, concentrated: vidaXL alone carries 80 apices for us; Swiss Post e-voting caps at $230k,
Doctolib and Kiteworks at $50k each. Bounties land in an e-wallet; add bank details to withdraw.

## 4. Intigriti — `https://app.intigriti.com/signup`

Six programmes carry our apices (Intergamma, AS Watson, Kinepolis, Posti, DigitalOcean, Delen). Complete
**identity verification before submitting** — an unverified researcher's payout sits in an error state,
so doing it after a win means waiting on KYC you could have done on day one.

## After each signup — the handoff that makes me useful

1. Update the vault: `python3 engine/vault.py set <platform> status=created username=<chosen>`.
2. Log in once **in the Hermes browser profile** (`$TMPDIR/chr-cdp-profile`, the one `scripts/cdp_render.py`
   uses) and tick "remember this device". From then on I can navigate, match scope, draft and file
   follow-ups inside that live session without ever holding your password.
3. Turn on TOTP. Default: your authenticator only. If you want me to drive sessions unattended, the
   TOTP secret can also go in the vault so codes are generated locally — say so explicitly, because that
   makes the vault a complete key to the accounts.

## KYC — what actually gates what (YesWeHack, via MangoPay)

YesWeHack's KYC is run by their payment provider, **MangoPay**, and the verified status is mandatory for
**two** separate things: submitting a report on a Bug Bounty programme, *and* transferring a reward to a
bank account. There is no path that skips it.

**The fork that matters for RDW.** MangoPay treats a hunter as `NATURAL` (a person) by default.
Withdrawing to a **company** bank account requires a *company* verification instead, with extra steps and
a location-dependent document set — YesWeHack routes that through `support@yeswehack.com`. That is a
second, slower queue sitting behind the first.

Recommended sequence, so the fast gate does not wait on the slow one:

1. Complete **individual** KYC now (5 minutes) — that is what unlocks *submitting*, which is the only way
   to create a reward in the first place.
2. Before the **first withdrawal**, open the company route with support so the money lands in RDW's
   account rather than a personal one. Do not withdraw to a personal account in the meantime: YWH issues
   a monthly invoice in the verified identity's name, and re-papering that after the fact is worse than
   waiting a week.

**Documents MangoPay accepts** (from their own guidelines — these are the rules rejections are judged
against):

- A **colour photograph**, never a flatbed scan or photocopy.
- **Passport**: both pages of the data spread in **one** file. **ID card / licence / residence permit**:
  front and back as **two** files on one document.
- All four edges visible, no crop; the **MRZ lines** and photo fully legible; no glare or flash; not blurred.
- **PNG, JPG/JPEG or PDF**, between 32 KB and 7 MB. One document type per submission.
- The name, date of birth and address on the YesWeHack profile must match the document exactly — editing
  them afterwards downgrades a verified status to `OUT OF DATE` and forces a re-submission.

**Also mandatory before submitting anything:**

- **SCA** — strong customer authentication, a phone number plus a PIN, demanded when registering a bank
  account or reading wallet data (valid 180 days). This is the second reason the phone number is needed.
- **Billing mandate** — YesWeHack generates the monthly invoice on your behalf; it is mandatory to use
  the platform at all, and it takes the verified identity's details.

## House rule, unchanged

The EIN, routing number and account number go into the platform's own fields, entered by you. They never
appear in this transcript, in the repo, or in a file I write. What I keep is the account list, the
usernames and the passwords for accounts **we** created — nothing that can move money.
