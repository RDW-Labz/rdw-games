# Legal documents

> These are the published, production legal documents for **BinGo Auctions**, a
> single-operator online auction house operated by **RDW, LLC** (Arkansas LLC).
> Governing law: Arkansas. Brand / d/b/a: BinGo Auctions. Entity (as registered
> with the Arkansas Secretary of State): `RDW, LLC`. BinGo Auctions is the
> auctioneer and seller of record — it is not a marketplace and there are no
> third-party operators.

## Files

| Slug | File | Audience |
|---|---|---|
| `terms` | [`terms.md`](./terms.md) | All users (signup gate) |
| `privacy` | [`privacy.md`](./privacy.md) | All users (signup gate, CCPA/CPRA/TDPSA/VCDPA/CPA disclosures) |
| `bidder-agreement` | [`bidder-agreement.md`](./bidder-agreement.md) | Bidders (one-time accept before first bid) |
| `dmca-policy` | [`dmca-policy.md`](./dmca-policy.md) | IP rights holders (Section 512(c) takedown procedure) |
| `prohibited-items` | [`prohibited-items.md`](./prohibited-items.md) | All users (Schedule A — incorporated by ref into ToS §5) |

> Note: the multi-operator `operator-agreement.md` was retired when BinGo was
> forked into a single-operator product. There are no third-party operators, so
> there is no operator onboarding gate.

## Where they're served

Public URLs on the operator-web Next.js app:

- https://bingoauctions.com/legal/terms
- https://bingoauctions.com/legal/privacy
- https://bingoauctions.com/legal/bidder-agreement
- https://bingoauctions.com/legal/dmca-policy
- https://bingoauctions.com/legal/prohibited-items

Route: `apps/operator-web/src/app/legal/[slug]/page.tsx`. Allowed-slug list lives in
the same file (anything else 404s). The slug → filename map in
`scripts/generate-legal-content.mjs` is the source of truth for which docs are
renderable.

## Publish gate

Each doc has a row in `policy_versions` (Supabase). The route only serves a doc if
`policy_versions.published = TRUE` for that `slug`. Returns 404 otherwise.

To publish or update a doc:

1. Edit the `.md` file in this directory.
2. Compute SHA-256 of the file contents:
   ```bash
   python -c "import hashlib; print(hashlib.sha256(open('legal/terms.md','rb').read()).hexdigest())"
   ```
3. Either bump `version` and INSERT a new row, OR UPDATE the existing `(slug, version)`
   row with the new `content_hash` and `effective_at`:
   ```sql
   UPDATE policy_versions
   SET content_hash = '<sha256>', effective_at = now(), published = TRUE
   WHERE slug = 'terms' AND version = 1;
   ```
4. Deploy the operator-web Worker so the bundled markdown (embedded at build time
   via `scripts/generate-legal-content.mjs`) reflects the new text. The `published`
   flag is read fresh from the DB on every request.

## E-SIGN consent capture

Acceptance is recorded in `terms_acceptances` via the `record_consent(slug, version,
method)` RPC. Captures `user_id`, `ip_address`, `user_agent`, `consent_method` (e.g.
`signup_checkbox`, `first_bid`, `reaccept_on_version_bump`). The audit trail is
immutable (no DELETE policy).

## When you bump a doc materially

For substantive changes (not typo fixes), increment `version` in `policy_versions`
rather than overwriting.

**A version bump does NOT make existing users accept again.** (Corrected
2026-09-29; this said it did.) These documents are accepted once, at signup
(`consent_slugs` in the signup flows); nothing checks the version before a bid,
and `place_bid` doesn't look at `terms_acceptances`. A bump only changes which
version NEW signups record (`get_active_policy_versions`, latest published by
`effective_at`).

To make bidders accept again before their next bid, change the operator's
**seller policy** (`operator_policies`, Account → Policies in the admin site)
and publish a new version. The bidder app shows its seller-terms box whenever
the bidder hasn't accepted the latest published version
(`apps/bidder-app/app/lot/[id].tsx`, `operator_policy_acceptances`); the website
does the same once the website seller-policy gate ships.

Order for a text change: deploy the website first (the markdown is bundled at
build time), then insert/update the `policy_versions` row, so no one records a
version they weren't shown.

What counts as "material":
- Liability cap or arbitration clause changes
- New fee structure (e.g. buyer's premium changes)
- New data-sharing relationships (new processor) for Bidders
- New prohibited item category
- Any change a regulator would flag as a notice-triggering event

For these, also send a notification email to all current users 30 days before the new
version's `effective_at` date.

## Cross-references

The docs cite each other (e.g. `terms.md §11` references `/legal/dmca-policy`). If
you rename a slug, audit cross-references in all other docs before publishing.

## Contact

`RDW, LLC d/b/a BinGo Auctions`
General legal: legal@bingoauctions.com
Privacy inquiries: privacy@bingoauctions.com
DMCA takedowns: legal@bingoauctions.com (subject line "DMCA Takedown Notice")
