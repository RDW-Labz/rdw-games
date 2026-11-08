# Operator console fork-legacy audit — 2026-07-04

Sweep of `apps/operator-web/src/app/(operator)` (+ its API/cron dependencies)
for ClovrBid/Stripe-era leftovers after the Square cutover. Everything below
was verified by reading the code, not pattern-matched.

## Fixed in this PR (copy + dead-ends only; no gate logic touched)

| # | Where | What was wrong | Fix |
|---|---|---|---|
| 1 | **`/onboarding` (30 call sites)** | Upstream's operator-onboarding wizard was deleted in the fork, but ~30 operator pages still `redirect('/onboarding')` for non-staff logins, and the dashboard "Test mode → Finish setup" banner links there. **Every one 404'd.** | New minimal `/onboarding` page: staff → dashboard; non-staff → "ask a BinGo admin to invite you from Staff" + storefront/login links. |
| 2 | **Cron health-check alerts** (`api/cron/health-check/route.ts`) | Ops alert email fell back to **`clovrbid@gmail.com`** when `OPS_ALERT_EMAIL` is unset — and `deploy-cloudflare.yml` silently skips unset secrets, so this is a live misdirection risk. | Fallback → `jmacluer@gmail.com` (super-admin). **Action: set `OPS_ALERT_EMAIL` explicitly on the bingo-web Worker.** |
| 3 | Reports → CSV export | Downloads named `clovrbid-June-2026-invoices.csv`. | → `bingo-…`. |
| 4 | Settlements page | Explainer described **Stripe Connect destination charges** settling to "your connected Stripe account". | Rewritten for the Square single-account model. |
| 5 | Disputes → resolve form | Checkbox "Issue **Stripe** refund"; failure toast "**Stripe** refund failed". (The API route behind it was already Square-native — copy only.) | "Issue card refund (Square)" / "Card refund failed". |
| 6 | Settings hub | Card labeled "**Stripe Tax** →". | "Sales tax →". |
| 7 | Settings → Sales tax page | Entire page pitched **Stripe Tax** with a `dashboard.stripe.com` deep-link (Stripe-purple button) as Option 1. | Rewritten around the real mechanism (mig 0214 flat-rate tax at invoice build); shows live state from `operators.collect_sales_tax`/`tax_rate_bps` ("✓ Enabled at 9.5%" for BinGo). Acknowledgement flow unchanged. |
| 8 | Settings → Policies, tax section | Option 1 claimed "BinGo Auctions adds no tax to charges" (now false — flat tax ships); option 2 branded "Stripe Tax". | Truthful flat-tax wording; de-branded "per-jurisdiction calculation — not yet available". |
| 9 | Dashboard "review" banner | "**Stripe** is reviewing your account… minutes for test accounts". | Processor-neutral wording. |
| 10 | Ops → stuck webhooks card | "…or **Stripe** never retried". | → Square. |

## Known-legacy left alone deliberately

| Item | Why untouched |
|---|---|
| Gates keyed on `stripe_onboarding_complete` / `stripe_charges_enabled` / `stripe_onboarding_skipped` (dashboard banners, scheduling, storefront) | Prod's single operator row has these set TRUE **on purpose**; re-keying to real Square readiness is flagged post-launch work (SESSION-HANDOFF-2026-07-01). Copy around them is now processor-neutral. |
| Route path `/settings/stripe-tax` | Cosmetic URL; dashboard checklist links to it. Renaming buys nothing before launch. |
| DB columns/enums (`stripe_event_id`, `tax_mode='stripe_tax'`, `issueStripeRefund` field name) | Internal identifiers, not user-visible; renaming = migration churn for zero UX gain. |
| `localStorage` keys `clovrbid:welcome-dismissed:*`, `clovrbid:city` | Invisible; changing them re-triggers dismissed banners for existing users. |
| Settlements page data model | The `settlements` table is Stripe-Connect-era; under Square single-account it stays mostly empty (page reads fine, shows "No paid invoices yet" money cards at $0 transferred). Revisit when payouts reporting matters. |
| `docs/`, code comments, Sentry project name `clovrbid-web` | Not user-facing. |

## Follow-ups recommended (not code)

1. **Set `OPS_ALERT_EMAIL` on the bingo-web Worker** (GH secret + redeploy) so alert routing doesn't depend on the code fallback.
2. Post-launch: re-key operator gates from `stripe_*` columns to Square readiness, then delete the "Test mode"/"review" banners outright.
