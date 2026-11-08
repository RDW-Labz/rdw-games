# Sales kit — DNS hygiene audits

The engine finds dangling records. The finding is free; this document is how the paid part is sold.

## What is being sold

**"DNS estate sweep"** — every subdomain of a zone, every CNAME, every dead vendor target, with a
report listing each dangling record, its provider, whether a third party can claim it, and the
exact one-line fix. Delivered as a PDF + the raw evidence, with a 30-minute walkthrough call.

It is not penetration testing, not a scan of their applications, and not a compliance audit. Say
that plainly on the first call — it keeps the engagement inside the one thing we are unambiguously
allowed to do (public DNS) and it makes the price look cheap rather than suspicious.

## Who buys it

Ranked by how likely they are to answer:

1. **Companies we already found a dangling record for.** They have proof in their inbox. This is the
   entire funnel: the free finding *is* the marketing.
2. **Web agencies and MSPs** with 50–500 client zones. One relationship, many zones, repeatable.
3. **Mid-market SaaS with a big vendor history** (many acquired products, many dead Heroku/Azure/AWS
   environments) — the density of decay is highest there.

Do not pitch enterprises first: they have a security team, a procurement process, and no reason to
trust an unsolicited email. The buyers are the ones with nobody doing this.

## Pricing ladder

| Item | Price | Notes |
|---|---|---|
| Single-zone sweep | $1,500 | Up to ~2,000 subdomains. Delivered in 3 business days. |
| Estate sweep (up to 10 zones) | $4,500 | The usual ask after a finding. |
| Monthly monitoring retainer | $750/mo | Recurring; this is the one worth having. |
| Re-test after remediation | $400 | Cheap, closes the loop, generates the case study. |

Never discount the first sweep — discount the retainer's first month instead. A free sweep teaches
the buyer the deliverable is worth nothing.

## How they pay — live rails, RDW Labz

Money lands in the **RDW Labz** location (`L6WC96AFWEZP8`, Harrison AR) — a location on the merchant
we already run, so the same bank settlement, separate reporting. Both links are live and verified
payable (see `PAYOUTS.md`):

- **Single-zone sweep — $1,500** → https://square.link/u/S3Z5A4mL
- **Monitoring, one month — $750** → https://square.link/u/3s4r8pVO

The first four offers went out with an earlier pair on the corporate "RDW" location
(https://square.link/u/h41lTw3P and https://square.link/u/7GnO5RnD). Those stay live — never delete a
link a prospect holds — but new material uses the RDW Labz pair.

Paste the relevant link into touch 2 or 3, never into touch 1 — the free finding goes out first and
carries no ask for money. For an estate sweep ($4,500) send the scope sheet and a Square invoice
instead of a fixed link, so the line items match the signed scope.

## Email sequence

**Touch 1 — the finding.** Subject: `dangling DNS record on <domain> — <host> (free heads-up, no
strings)`. Body: the record, the `NXDOMAIN`, what a stranger could do with it, "the fix is one DNS
deletion", report attached, "I am not asking anything for the finding". Final paragraph, one
sentence, offering the paid sweep. No attachment gating, no "reply to unlock".

**Touch 2 — +5 business days**, only if no reply. Re-send the record and the fix, note it is still
live, no pitch at all. This is the one that gets answered, because it proves persistence without
pressure.

**Touch 3 — +14 days.** Close the loop: "removing this from my list; if you want the rest of the
estate swept, that offer stands." Then stop.

Rules that are not negotiable:
- The finding goes out **before** any mention of money, in the same email but a later paragraph.
- Never imply publication, escalation, or a deadline for payment. That is extortion, and it converts
  a good-faith disclosure into a legal problem.
- Never claim or serve anything at the customer's hostname, not even to "demonstrate" it. The report
  argues from DNS and provider documentation.
- If they say no, the finding stays disclosed and free. Reputation is the asset in stream 1.

## Deliverable template

`templates/audit-scope.md` — one page, sent before work starts: zones in scope, what is checked,
what is explicitly out of scope, price, delivery date. Signing it takes two minutes and prevents the
"we thought you'd test the app" conversation later.

## Objections and answers

| Objection | Answer |
|---|---|
| "We get these emails all the time." | "Most of them are generic. This one has your record and your `NXDOMAIN` in it — check it yourself in ten seconds." |
| "Our DNS provider handles this." | "They handle resolution, not hygiene. The record is still there and still dead." |
| "We'll just fix it ourselves." | "Please do — that's the win. The sweep covers the other 400 records you haven't looked at." |
| "Is this legal?" | "It's public DNS. I never touch your servers." |

## What makes the number move

Reply rate, not pipeline size. 40 emails with a real finding beats 4,000 without. Track two numbers
only: findings disclosed, and replies received. If replies are under 5%, the email is wrong — not
the price.
