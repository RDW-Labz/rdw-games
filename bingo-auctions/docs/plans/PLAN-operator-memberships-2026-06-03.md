# PLAN — Operator Memberships ("Pro per operator")

**Status:** 🟡 DRAFT FOR REVIEW — no implementation until approved
**Date:** 2026-06-03
**Author:** Claude (synthesis of 3 read-only grounding investigations against `master` @ `#187`)
**Driving requirement (verbatim):** *"my vision for pro subscriptions would go to the operators, they can offer extended pickups, extra grace, … or even a stage and prep, I imagined it customizable, then they can offer that subscription to their bidders, then my platform commission would just come out of that. So bidders could have different pro subs to different operators."* … *"lets drop … Early bidding hours … and MSRP filters / members-only views … and go with the other 3. I want to plan this out, I don't want to mess other stuff up like we did yesterday."*

---

## 0. TL;DR (read this first)

- **We are extending, not building.** A per-operator paid bidder-membership system **already ships in production** (migrations `0008` + `0013`): a `bidder_subscriptions` table keyed `(bidder_id, operator_id)`, an `is_subscriber(operator_id)` RLS primitive, a Stripe `customer.subscription.*` webhook that upserts subscription state, and an operator settings editor. A bidder can already be Pro at multiple operators with separate Stripe subs. **This is exactly the model requested.** We swap the *perks* and fix the *money flow*.
- **The 3 perks are real-world services** → Apple **3.1.3(e)** exemption (sold outside IAP, same as how bidders already pay for won lots). Dropping the 2 digital perks (early-bidding hours, MSRP/members-only) is what *keeps* memberships IAP-exempt. **v1 hides Pro on mobile entirely → zero IAP surface on iOS/Android.**
- **Lowest-regression schema:** add ONE new table `operator_pro_plans` (holds the perk magnitudes + per-plan Stripe price) and add ONE nullable column `plan_id` to the existing `bidder_subscriptions`. This leaves `is_subscriber()`, the webhook upsert, `useOperatorFeatures()`, and account-deletion cascades **untouched**.
- **The one real money-path change:** today's membership checkout gives the operator **$0** and makes the *platform* the merchant of record. It must be rewritten to a Connect **destination-charge subscription** (`on_behalf_of` + `transfer_data.destination` + `application_fee_percent`) so the **operator is merchant of record and the platform skims a commission**. This reuses the bidder's already-saved card — no per-operator card re-collection.
- **Each perk plugs into exactly one existing hook point.** Extra-grace = 1 TS function. Extended-pickup = 1 `CREATE OR REPLACE` of the no-show cron. Staging-prep = a UI badge (no schema). Each has explicit "don't break X" guardrails below.

### Decisions — all 5 locked ✅ (details in §11)
✅ #1 commission = **single flat knob `membership_fee_bps`, default 5%** (owner sets 4–5% pre-launch; distinct from the tiered GMV brackets) · ✅ #2 extended-pickup = **grace/forfeit only** · ✅ #3 staging = **badge, not a mode-flip** · ✅ #4 price = **$0.99–$49.99** · ✅ #5 schema = **Option B-lite**. **The plan is complete and ready for review.**

---

## 1. Goal & scope

### In scope — the 3 real-world perks
| Perk | What the bidder gets | Real-world? |
|---|---|---|
| **Extended pickup window** | More days to collect physical lots before no-show/forfeit | ✅ physical warehouse logistics |
| **Extra payment grace** | Longer grace before a failed payment becomes a relist fee | ✅ payment terms on physical goods |
| **Staging & prep** | White-glove: staff stage & prep the member's lots ahead of arrival | ✅ physical service at the warehouse |

All three are **operator-customizable** (each operator sets the magnitudes and the monthly price), sold by the operator to **their** bidders. Platform takes a commission via Stripe Connect.

### Explicitly OUT of scope (dropped, by your decision)
| Dropped perk | Why dropped |
|---|---|
| **Early bidding hours** | In-app *digital* advantage → Apple **3.1.1** would require IAP. Removing it keeps memberships outside-IAP. |
| **MSRP filters / members-only views** | In-app *digital content* → IAP risk; also already superseded by the modern `bidder_features` JSONB flag system. |

> ⚠️ **Compliance invariant:** because memberships are sold **outside Apple IAP**, every perk MUST stay a real-world service. **Never re-add a digital/in-app perk to the membership** without moving that perk to IAP — doing so would make the whole product non-compliant.

---

## 2. Compliance framing (Apple + Google)

- **Apple 3.1.3(e) "Goods and Services Outside the App":** apps may sell physical goods/services consumed outside the app without IAP. Lot pickup, payment terms, and physical staging all qualify. **This is the same exemption Apple already approved** for bidders paying for won lots via Stripe (not IAP).
- **v1 decision — Pro hidden on mobile:** the bidder-app subscription screen is *not linked into any tab* today and iOS already hard-blocks in-app subscribe (routes to web). v1 keeps it hidden on **both** iOS and Android. **Net effect: there is no in-app purchase surface at all for v1 → the IAP question doesn't even arise.** Bidders subscribe on the web.
- **v2 (if ever surfaced in-app):** lean on the real-world-services framing; keep all perks real-world; do not link out to web payment in a way that violates anti-steering (sell the *service*, fulfilled outside the app).
- **Google Play:** real-world-services equivalent applies; external billing is currently permitted in the US regardless. Keep the Data Safety form consistent (no new data types collected — memberships reuse the existing Stripe customer).
- **Sales tax:** do **NOT** add `automatic_tax` to membership subscriptions (this is the exact param that broke all charges on 2026-06-02). Tax on memberships = explicit v2 consideration.

---

## 3. What already exists (reuse inventory — do not rebuild)

| Asset | Location | Reuse verdict |
|---|---|---|
| `bidder_subscriptions` table (`(bidder_id, operator_id)` UNIQUE, `status`, `current_period_end`) | `packages/db/migrations/0013_pro_per_org_settlements.sql:35` | **Reuse + add `plan_id`** |
| `is_subscriber(p_operator_id UUID)` SQL fn (active/trialing + unexpired) | `0013:126` | **Reuse unchanged** (RLS-critical primitive) |
| `useOperatorFeatures()` → `{tier:'free'|'pro'}` | `packages/supabase-client/src/operator-features.ts:37-48` | **Reuse unchanged** |
| `subscription_status` enum (`none/trialing/active/past_due/canceled`) | `0008:50` | **Reuse** (webhook already maps Stripe → this) |
| Stripe webhook `customer.subscription.*` → upsert sub | `apps/operator-web/src/app/api/webhooks/stripe/route.ts:652-758` | **Reuse + add `plan_id` to upsert; tighten `kind`** |
| `ensureProProductAndPrice()` (creates Product+Price on **platform** account) | `apps/operator-web/src/lib/stripe.ts:217` | **Reuse, make per-plan** (correct topology for destination charges) |
| Operator settings editor `ProTierSection` + `saveProSettings` | `…/settings/SettingsForm.tsx:284-418`, `…/settings/actions.ts:82-152` | **Repurpose** into the Membership editor |
| Settings sub-page triad pattern (`page.tsx`+`Form.tsx`+`actions.ts`) | `…/(operator)/settings/policies/` | **Template** for `/settings/membership` |
| Staging flow (`bin_assignments`, `assign_lot_to_bin`, `pickup_ready` notif) | `apps/field-mobile/app/(staff)/checkout/stage.tsx` | **Reuse as-is** (perk 3 is just a *signal*) |

> 💡 The existing Stripe-side plumbing already puts the Price on the **platform** account — which is exactly what the recommended destination-charge model needs. Happy accident: only the *subscription-create call* and the *bidder-side flow* need changes, not the Product/Price provisioning.

---

## 4. Architecture decision — schema (RECOMMENDED: "Option B-lite")

There are two genuinely separable questions:

1. **Where do perk *parameters* live?** (`extended_pickup_days`, `extra_grace_hours`, `staging_prep`) → these don't exist anywhere today → **new table `operator_pro_plans`**.
2. **Where does the bidder↔operator *subscription state* live?** → `bidder_subscriptions` already exists and is read by `is_subscriber()` (RLS), the webhook upsert, `useOperatorFeatures()`, and deletion cascades.

**Recommendation:** create `operator_pro_plans` and **extend `bidder_subscriptions` with a nullable `plan_id`** — do **not** spin up a parallel `bidder_pro_subscriptions` table.

| | Option A (extend `pro_*` cols on `operators`) | **Option B-lite (RECOMMENDED)** | Option B-full (Agent's literal sketch) |
|---|---|---|---|
| Perk params | crammed onto `operators` | `operator_pro_plans` table (named, multi-tier-ready) | `operator_pro_plans` table |
| Subscription state | `bidder_subscriptions` (no plan link) | `bidder_subscriptions` **+ `plan_id`** | **new** `bidder_pro_subscriptions` |
| `is_subscriber()` change | none | **none** ✅ | **required** (RLS landmine) |
| Webhook upsert target change | none | add `plan_id` to payload | rewrite to new table |
| Deletion cascade / `useOperatorFeatures` change | none | **none** ✅ | required |
| Multi-plan per operator | ❌ one implicit plan | ✅ | ✅ |
| Blast radius | small but cramped | **smallest that supports named plans** | largest |

Option B-lite gets named, multi-tier-ready plans **and** leaves every existing consumer of `bidder_subscriptions` untouched. This is the "don't mess other stuff up" choice.

---

## 5. Proposed schema (migration `0177`)

> Numbering: master max = `0176`; next = **`0177`**. Gaps exist (no 0168/0169/0171/0172) — **do not backfill**, just continue forward. (Note: `0175`/`0176` are merged on master per the file tree; confirm at author time.)

```sql
-- 0177_operator_memberships.sql

-- (1) NEW: operator-defined membership plans (operator-scoped) --------------
CREATE TABLE operator_pro_plans (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id          UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  price_cents          INTEGER NOT NULL CHECK (price_cents BETWEEN 99 AND 4999),  -- operator picks $0.99–$49.99 (confirmed)
  -- the 3 real-world perks (magnitudes/flags) --------------------------------
  extended_pickup_days INTEGER NOT NULL DEFAULT 0 CHECK (extended_pickup_days BETWEEN 0 AND 30),
  extra_grace_hours    INTEGER NOT NULL DEFAULT 0 CHECK (extra_grace_hours BETWEEN 0 AND 168),
  staging_prep         BOOLEAN NOT NULL DEFAULT false,
  active               BOOLEAN NOT NULL DEFAULT true,
  -- Stripe (Product/Price live on the PLATFORM account — correct for
  -- destination charges; minted via ensureProProductAndPrice() pattern) ------
  stripe_product_id    TEXT,
  stripe_price_id      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operator_pro_plans_operator_idx ON operator_pro_plans (operator_id) WHERE active;

ALTER TABLE operator_pro_plans ENABLE ROW LEVEL SECURITY;

-- bidders/anyone may read ACTIVE plans of ACTIVE operators (to subscribe)
CREATE POLICY operator_pro_plans_public_read ON operator_pro_plans
  FOR SELECT USING (
    active = true
    AND EXISTS (SELECT 1 FROM operators o
                WHERE o.id = operator_pro_plans.operator_id AND o.status = 'active')
  );
CREATE POLICY operator_pro_plans_staff_read ON operator_pro_plans
  FOR SELECT USING (operator_id = (SELECT current_operator_id()));
CREATE POLICY operator_pro_plans_staff_insert ON operator_pro_plans
  FOR INSERT WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin','manager'));
CREATE POLICY operator_pro_plans_staff_update ON operator_pro_plans
  FOR UPDATE USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin','manager'))
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin','manager'));
CREATE POLICY operator_pro_plans_staff_delete ON operator_pro_plans
  FOR DELETE USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin');

CREATE TRIGGER operator_pro_plans_set_updated_at
  BEFORE UPDATE ON operator_pro_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- (2) EXTEND existing subs table — purely additive --------------------------
ALTER TABLE bidder_subscriptions
  ADD COLUMN plan_id UUID REFERENCES operator_pro_plans(id) ON DELETE RESTRICT;
-- nullable so all existing rows + is_subscriber()/webhook/cascades keep working.

-- (2b) Platform membership commission — ONE flat knob (mirrors operators.application_fee_bps)
ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS membership_fee_bps INTEGER NOT NULL DEFAULT 500
  CHECK (membership_fee_bps BETWEEN 0 AND 10000);  -- 500 = 5.00%; owner sets 400–500 before launch.
-- NOT the tiered GMV rate (compute_application_fee_cents / mig 0087) — a Stripe sub fee is one flat %.

-- (3) DATA MIGRATION: seed one plan per currently pro_enabled operator -------
-- maps legacy operators.pro_monthly_cents + pro_stripe_* into a default plan,
-- then backfills bidder_subscriptions.plan_id for live subs. (Spell out in PR.)
```

**Convention compliance (verified against the codebase):**
- Cents as `INTEGER … _cents` with `>= 99` floor — matches `operators.pro_monthly_cents` + `saveProSettings`' `z.number().int().min(99)`.
- RLS helper calls **pre-wrapped** in `(SELECT …)` per migration `0133` (initPlan once-per-query, not per-row). The `0133` verification block asserts zero unwrapped calls — new policies must ship wrapped.
- **H3 (audit 0028):** the subs table carries `stripe_subscription_id`; operator-read is gated to **admin/manager**, never pickers. `bidder_subscriptions` already enforces this — we add no new exposure.
- `subscription_status` enum **reused** (do not invent a new status type).
- `set_updated_at()` trigger + `active BOOLEAN` soft-disable — house patterns.

**Optional plan-aware helper** (for client/RLS paths where `auth.uid()` is set — NOT for crons, see §7):
```sql
CREATE FUNCTION my_active_pro_plan(p_operator_id UUID) RETURNS operator_pro_plans
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.* FROM bidder_subscriptions s
  JOIN operator_pro_plans p ON p.id = s.plan_id
  WHERE s.bidder_id = auth.uid() AND s.operator_id = p_operator_id
    AND s.status IN ('active','trialing')
    AND (s.current_period_end IS NULL OR s.current_period_end > now())
  LIMIT 1;
$$;
```

### Early-access RLS — the one thing to leave alone in v1
`is_subscriber()` is referenced by the `lots_bidder_read_published` RLS policy (the dropped early-access perk). **v1 leaves this RLS untouched.** Because we remove the *operator config surface* that ever set early-access, the clause becomes an inert no-op. A **follow-up low-risk migration** can delete the dead clause *after* confirming no operator has early-access configured. Do not touch `is_subscriber()` or `lots_bidder_read_published` in `0177` — that is gratuitous RLS risk.

---

## 6. Stripe Connect money flow (the one real money-path change)

**Today (broken for this purpose):** `…/api/subscriptions/checkout/route.ts:67-79` creates a **plain platform-account** subscription — no `application_fee_percent`, no `transfer_data`, no `on_behalf_of`. Result: **100% of membership revenue lands on the platform and the operator gets $0**, and the *platform* (not operator) is merchant of record. This contradicts the requirement and must be rewritten.

**Recommended model — destination-charge subscription** (the only model that reuses the bidder's existing saved card):

```js
// server-side, PLATFORM-scoped Stripe client
stripe.subscriptions.create({
  customer: bidder.stripe_customer_id,                 // EXISTING platform-account customer
  items: [{ price: plan.stripe_price_id }],            // plan's Price on the platform account
  on_behalf_of: operator.stripe_account_id,            // operator = settlement merchant + branding
  transfer_data: { destination: operator.stripe_account_id },
  application_fee_percent: operator.membership_fee_bps / 100,  // = membership_fee_bps/100; default 5.00% (decision #1 — resolved)
  default_payment_method: bidder.default_payment_method_id,
  metadata: { kind: 'operator_membership', operator_id, bidder_id, plan_id },
});
```

**Why destination-charge, not Stripe's "recommended" direct-charge:** direct charges require the customer + card to live **on each connected account**, which would force re-collecting every bidder's card per operator — a non-starter given the single-global-bidder-identity model and the mandatory-card-on-file onboarding. Destination charges keep the customer + card on the platform account (where they already are) while `on_behalf_of` makes the operator the merchant of record with their branding on invoices/receipts. The lot-charge path already uses this exact topology.

**Platform commission rate (decision #1 — RESOLVED):** a Stripe subscription fee must be `application_fee_percent` (you *cannot* set a flat recurring `application_fee`). **Resolution:** the rate is a single platform knob **`operators.membership_fee_bps`** (default `500` = 5.00%; owner sets 4–5% before launch), applied as `application_fee_percent = membership_fee_bps / 100`, super-admin-editable, mirroring the existing `application_fee_bps` column. This is intentionally a **flat** rate, **distinct from the tiered/bracketed GMV commission** (`compute_application_fee_cents`, mig `0087` — brackets by monthly volume + founder discount): a subscription fee can only be one percent, so memberships use this single knob rather than mirroring the GMV brackets. (A flat *$/mo* cut instead of a % would need per-invoice `application_fee_amount` injection via an `invoice.created` hook — not needed.)

**Webhook delta** (`…/api/webhooks/stripe/route.ts`):
| Event | Today | Delta |
|---|---|---|
| `customer.subscription.created/updated/deleted` | ✅ upserts `bidder_subscriptions` on `(bidder_id, operator_id)` | **Add `plan_id`** (from `sub.metadata`) to the upsert; set explicit `kind:'operator_membership'` and tighten the branch test (today's branch match is fragile). |
| `invoice.paid` | ❌ not handled | **Add** — extend `current_period_end` on renewal. |
| `invoice.payment_failed` | ❌ not handled (PI handler breaks early on non-`invoice` kinds) | **Add** — flip status to `past_due`, notify bidder (subscription dunning is invoice-driven, not PI-driven). |

> Destination-charge subscription events fire on the **platform** webhook destination (`STRIPE_WEBHOOK_SECRET_PLATFORM`) — the same path the existing bidder-sub handler already uses. **No new connect-destination webhook wiring needed.** (Direct charges would have required per-connected-account routing — another reason destination-charge is lower-friction.)

**Other money-flow items:**
- **Web subscribe/manage pages don't exist.** `checkout`/`portal` routes point at `/subscriptions`, `/subscriptions/success`, `/subscriptions/cancel` — none are built. Since iOS routes bidders to the web to subscribe, **these pages are required, not optional.**
- **Connect disconnect:** when an operator disconnects, `on_behalf_of` subs stop auto-charging (invoices stay draft). The existing `account.application.deauthorized` handler already flips `stripe_charges_enabled=false`; membership lifecycle should pause/surface affected subs.
- Move the Stripe Price IDs from `operators.pro_stripe_*` → `operator_pro_plans.stripe_*`; `checkout` looks up by `planId`.
- **Per CLAUDE.md Rule 4: invoke the `stripe-best-practices` skill when speccing the implementation PR** (Billing + Connect subscriptions).

---

## 7. Perk-enforcement map (THE HEART — with "DON'T BREAK X" guardrails)

### Perk 1 — Extended pickup window
- **Hook point:** the `due` CTE inside `auto_mark_pickup_no_show()` — `packages/db/migrations/0166_pickup_forfeit.sql:103-113` (runs every 30 min via pg_cron). It already `JOIN`s `operators`. Current deadline:
  `COALESCE(pickups.scheduled_at, auctions.pickup_ends_at) + (COALESCE(operators.pickup_grace_extension_hours, 24) * INTERVAL '1 hour')`.
- **Change:** add `LEFT JOIN bidder_subscriptions bs ON bs.bidder_id = i.bidder_id AND bs.operator_id = i.operator_id AND bs.status IN ('active','trialing') AND (bs.current_period_end IS NULL OR bs.current_period_end > now()) LEFT JOIN operator_pro_plans p ON p.id = bs.plan_id`, then add `+ (COALESCE(p.extended_pickup_days,0) * 24) * INTERVAL '1 hour'` to the deadline. One `CREATE OR REPLACE` of one function (mirrors the existing 0155→0166 chain).

> 🛑 **DON'T BREAK:**
> - **The cron has NO `auth.uid()`** (pg_cron context) — it **MUST inline the join** keyed on the invoice's `bidder_id`. **Do NOT call `my_active_pro_plan()`** here (it reads `auth.uid()` → NULL → wrong/empty). The helper is for client/RLS paths only.
> - **Never write to `auctions.pickup_ends_at`.** That column is shared by *all* winners of the auction. The extension is a **per-bidder delta computed in the cron**, never a row write.
> - **COALESCE-guard** every new term (the existing fallback is `COALESCE(..., 24)`).
> - **Decision #2 — slot booking:** `schedule_pickup()` (`0007:176`) and `get_pickup_slots()` (`0007:63-64`) reject bookings outside `[pickup_starts_at, pickup_ends_at]`. v1 recommended: extend **only the no-show/forfeit deadline** (the cron) — a member is protected from forfeit longer but books slots within the normal window. If you also want members to *book* later slots, those two functions need the same per-bidder bump (more risk). Member-facing copy must match whichever you pick.
> - **Bidder-facing window labels** (`…/profile/pickup/page.tsx:178`, bidder-app `pickup/[id].tsx`) show the *raw* auction window. v1: show base window + a "Pro: +N days protection" note rather than rewriting the displayed window (least invasive).

### Perk 2 — Extra payment grace
- **Hook point:** `flipInvoiceToGrace()` — `apps/operator-web/src/lib/cron/auto-charge-drain.ts:514-528`. It already accepts a `graceHoursOverride` param (`:505`) and already has the `operators` row joined (`:139`). Resolve a per-bidder bump: if the invoice's bidder has an active sub at that operator, `graceHours = operatorGraceHours + COALESCE(plan.extra_grace_hours, 0)`, then write `grace_until = now() + graceHours`. **Single-file TS change.** (Extend the batch select at `:139/:145` to include the bidder's sub+plan.)

> 🛑 **DON'T BREAK:**
> - **`grace-expiry.ts` reads `grace_until` (the written timestamp), NOT the policy** — so extended grace works automatically once the longer `grace_until` is written. **No change to `grace-expiry.ts`.**
> - **Relist-fee / bid-block coupling:** `grace_until` is the single gate before the relist fee + the `place_bid` block on `unpaid_fees_cents > 0` (`0105:333`). Both crons key off `grace_until`, so writing the extended value **once** is sufficient and safe — a Pro member won't be relist-fee'd at the operator's shorter window.
> - **SCA `requires_action` path** (`:419-449`) does NOT flip to grace and deletes the job — **leave it alone**.
> - **Keep the decline push copy generic** (`enqueueDeclineNotification` `:582-601` was deliberately made operator-agnostic — "grace varies by operator"). Stays correct for Pro vs free without change.

### Perk 3 — Staging & prep
- **⚠️ Framing (verified against code):** "Stage & prep" is **NOT a per-bidder pickup mode.** A `pickup_mode` taxonomy already exists (`staff_assisted` / `counter_pickup` / `self_serve_floor_plan` / `hybrid`; migs `0094`+`0165`, resolved per warehouse/auction via `COALESCE(auctions.pickup_mode_override, warehouses.pickup_mode)`) with **no per-bidder dimension**. Flipping a member's mode would touch every mode-resolution RPC + the 4-branch bidder pickup UX (high blast radius). The perk = **staff proactively create `staged` `bin_assignments` for the member's won lots** (works in *any* mode, incl. self-serve) → surfaced as a badge. (See §13 for the full fulfillment-mode picture.)
- **Hook point:** staging already fully works (`bin_assignments` + `assign_lot_to_bin` + `pickup_ready` notification + `stage.tsx`). The perk is purely a **signal to staff**: "this winner is Pro → stage & prep ahead of arrival."
  - **Best surface (proactive):** the **worklist** (`apps/field-mobile/app/(staff)/worklist/[id].tsx`) — staff need to know *before* the bidder arrives. Add a Pro flag per won-invoice.
  - **Secondary (reactive):** a "PRO — staged & prepped" badge on `pickup-verify.tsx` (which already loads the invoice + bidder). Query `bidder_subscriptions` for `(bidder_id, operator_id)`.
- **Net-new UI, NO schema change** (rides on existing tables + `is_subscriber`).

> 🛑 **DON'T BREAK:**
> - **Never write `'unstaged'`** — the `bin_assignment_status` enum (`0001`) only has `('staged','picked_up','returned_to_floor')`; "no row = unstaged" is the convention (`pickup-verify.tsx:78`).
> - **Never flip `pickup_mode` per-bidder** — it's a warehouse/auction-level setting with no per-bidder hook. The perk is a staff signal + proactive staging, not a mode change.
> - **Decision #3:** v1 recommended = reuse the existing `staged` status + a Pro **badge** (zero risk). A distinct `'prepped'` state = additive `ALTER TYPE` + touches `assign_lot_to_bin` + pickup-verify's status mapping (`:393-398`). Defer unless you want a separate prepped sub-state.
> - Staging is **decoupled from money/no-show paths** → lowest regression of the three.

---

## 8. UI surfaces (file paths)

| Actor | Surface | Status / action |
|---|---|---|
| **Operator** | `/settings/membership` (new triad `page.tsx`+`MembershipForm.tsx`+`actions.ts`) | New, copy `…/settings/policies/`; hub link in `…/settings/page.tsx:40-66`. Repurpose `ProTierSection` + `saveProSettings` (already edits perks+price+Stripe sync) as the starting point — swap the 3 dropped perks for the 3 new ones. |
| **Operator** | `pickup_grace_extension_hours` base config | Currently has NO operator UI (mig-0144 DB default only). If operators are to set the *base* window the perk extends, add the field to `…/settings/policies`. |
| **Bidder (web)** | `/subscriptions`, `/subscriptions/success`, `/subscriptions/cancel` | **Build** (required — iOS routes here). Subscribe + manage (Stripe portal). |
| **Bidder (mobile)** | `apps/bidder-app/app/subscription/index.tsx` | **HIDDEN in v1** (not linked; iOS already hard-blocks). Rewrite for the 3 perks when surfaced later. Perk rendering at `:231-239` references the dropped flags. |
| **Operator CRM** | `…/(operator)/bidders/[id]/page.tsx` | Add a "Membership" section (query `bidder_subscriptions` ⨝ `operator_pro_plans`, admin/manager gated). Profile section at `:117-137`. |
| **Staff** | worklist `[id]` + `pickup-verify.tsx` | Pro flag/badge (perk 3). |

---

## 9. Remove / repurpose from the old Pro stub

| Item | Action |
|---|---|
| `operators.pro_early_access_minutes` / `pro_msrp_filter_enabled` / `pro_last_chance_members_only` | **Stop reading** (drop from settings UI + bidder screen). Defer the actual `DROP COLUMN` to a later cleanup migration (conservative). |
| `operators.pro_enabled` / `pro_monthly_cents` / `pro_stripe_product_id` / `pro_stripe_price_id` | **Keep**; `pro_monthly_cents`+`pro_stripe_price_id` migrate into the seeded default plan. |
| `is_subscriber()` | **Keep unchanged.** |
| `lots_bidder_read_published` early-access RLS clause | **Leave inert in v1**; dead-clause cleanup = separate follow-up migration. |
| `apps/bidder-app/app/subscription/index.tsx` (reads the 3 dropped flags) | Rewrite (the screen stays hidden in v1 regardless). |
| `…/settings/SettingsForm.tsx` `ProTierSection` + `…/settings/actions.ts` `saveProSettings` | Repurpose into the Membership editor. |
| `scripts/seed-app-reviewer-fixtures.mjs` (seeds the 3 dropped flags) | Update to seed a membership plan instead. |
| `bidder_features` JSONB + `FlagValue 'all'|'pro'|'off'` | Unrelated/modern; leave as-is (it's the replacement for the MSRP/filter idea). |

---

## 10. "Don't break X" master checklist (consolidated)

1. ❌ Never write `auctions.pickup_ends_at` for a per-bidder extension — compute the delta in the cron.
2. ❌ Never call `my_active_pro_plan()` from a pg_cron job — inline the join (no `auth.uid()` in cron).
3. ❌ Don't touch `is_subscriber()` or `lots_bidder_read_published` in `0177` (inert early-access cleanup is a separate migration).
4. ❌ Don't change `grace-expiry.ts` — it reads `grace_until`; extended grace flows automatically.
5. ❌ Don't touch the SCA `requires_action` path in `auto-charge-drain.ts`.
6. ❌ Don't add `automatic_tax` to membership subscriptions (the 2026-06-02 incident param).
7. ❌ Don't write `'unstaged'` to `bin_assignment_status` (enum has no such value); don't flip `pickup_mode` per-bidder (it's warehouse/auction-level — the perk is a staff badge, not a mode change).
8. ❌ Keep the decline-notification copy operator-agnostic.
9. ✅ Pre-wrap all new RLS helper calls in `(SELECT …)` (mig 0133).
10. ✅ Gate the subs table's operator-read to admin/manager (H3) — already enforced; don't loosen.
11. ✅ `bidder_subscriptions.plan_id` is **nullable** (additive; existing rows + consumers unaffected).
12. ✅ Membership subs are destination charges on the **platform** webhook secret — don't add connect-destination routing.
13. ✅ Pro stays **hidden on mobile** in v1 (no IAP surface).

---

## 11. Decisions (status)

1. ✅ **Platform commission — RESOLVED.** Membership cut = a **single flat rate**, `operators.membership_fee_bps` (default **500 = 5.00%**; owner sets 4–5% before launch), applied as `application_fee_percent`. One super-admin knob, mirroring `application_fee_bps`. NOTE: your *GMV* commission is **tiered/bracketed** by monthly volume (mig `0087`), but a Stripe subscription fee can only be one flat percent — so memberships use this single rate, **not** the GMV brackets. Still a 4th, additive revenue stream (stacks on operator platform fee + GMV commission + AI billing).
2. ✅ **Extended pickup** — *no-show/forfeit grace only* (no slot-booking extension).
3. ✅ **Staging & prep** — Pro **badge reusing `staged`** (NOT a per-bidder `pickup_mode` flip — see §7 + §13). `'prepped'` state deferred.
4. ✅ **Membership price** — operator picks **$0.99–$49.99** (`price_cents BETWEEN 99 AND 4999`).
5. ✅ **Schema** — **Option B-lite** (extend `bidder_subscriptions` + new `operator_pro_plans`).

**Only #1 (the commission %) blocks finalizing the money section.** Everything else is locked.

---

## 12. Rollout plan (phased, lowest-regression order)

| Phase | Work | Risk | Notes |
|---|---|---|---|
| **0 — Schema (prereq)** | `0177` migration: `operator_pro_plans` + `bidder_subscriptions.plan_id` + seed default plans; regen `database.types.ts` | Low (additive) | dry-run → inspect → `--live` → re-inspect |
| **1 — Money flow (prereq)** | Rewrite `subscriptions/checkout` (planId + `on_behalf_of` + `transfer_data` + `application_fee_percent`); webhook `invoice.paid`/`invoice.payment_failed` + `plan_id`; build web `/subscriptions/*` pages | Medium (money) | invoke `stripe-best-practices`; test on LIVE-test before prod |
| **2a — Perk 2 (extra grace)** | `flipInvoiceToGrace()` per-bidder bump | Low (1 file) | start here — smallest blast radius |
| **2b — Perk 3 (staging badge)** | Worklist + pickup-verify Pro flag | Low (UI only) | no schema |
| **2c — Perk 1 (extended pickup)** | `CREATE OR REPLACE auto_mark_pickup_no_show()` + decide slot booking | Medium (cron + money-adjacent) | dry-run the cron carefully |
| **3 — Surfaces** | Operator `/settings/membership` triad; operator CRM membership section; (mobile stays hidden) | Low | |
| **v1 gate** | Pro hidden on mobile; subscribe = web only | — | zero IAP surface |

**No implementation begins until §11 decisions are confirmed.**

---

## 13. Fulfillment-mode context (investigated 2026-06-03 — "look into this so we don't mess something up")

**Finding: the fulfillment model already exists in production.** No new fulfillment infrastructure is needed for memberships — the Pro "stage & prep" perk layers on top of what's already shipped. Two **orthogonal** axes:

| Axis | Columns | Levels | Your vision maps to |
|---|---|---|---|
| **A — `pickup_mode`** (HOW retrieved) | `warehouses.pickup_mode` + `auctions.pickup_mode_override` | warehouse default / per-auction override | self-serve = `self_serve_floor_plan` / `counter_pickup`; stage&prep = `staff_assisted` (the default); hybrid = `hybrid` |
| **B — `fulfillment_method`** (pickup vs ship) | `invoices.fulfillment_method` + `operators.offers_pickup`/`offers_shipping` + `operator_shipping_config` | operator capability / per-invoice | shipping (later) = `ship` (EasyPost stubbed) |

- **Effective mode** = `COALESCE(auctions.pickup_mode_override, warehouses.pickup_mode)` (migs `0094`+`0165`). 4 values: `staff_assisted`, `counter_pickup`, `self_serve_floor_plan`, `hybrid`. `0165` is the latest **taxonomy refinement** — build on it, don't duplicate.
- **Self-serve pickup is ~90% built** — enum value + full bidder floor-plan-map UX (`apps/bidder-app/app/pickup/[id].tsx:700+`) + self-confirm RPC `bidder_confirm_customer_pickup` (`0165:62`) + an operator config UI (`…/warehouses/[id]/pickup-mode/actions.ts`). The only genuinely-new behavior is "grab off the open floor with **zero** staging" — and even that is half-supported (`staff_confirm_pickup` already completes lots that have no `bin_assignment`).
- **Staging is already OPTIONAL, not universal** — `staff_confirm_pickup` completes unstaged lots without error; the verify screen explicitly models `'unstaged'`. So the perk's premise (staging is an *extra* service) holds, and "stage & prep" = staff proactively stage a member's lots in *any* mode → **badge**, not a mode change (see §7 Perk 3).

### 🛑 Forward-compat landmine (flag for the fulfillment roadmap — NOT this membership work)
The no-show cron `auto_mark_pickup_no_show` (`0166:103-113`) operates on **every** `pickups` row with **no `fulfillment_method='pickup'` filter** (and `ensure_pickup_row` creates a pickup row for all paid invoices). **Before shipping goes live**, add that predicate — otherwise `fulfillment_method='ship'` invoices get flipped to `no_show` and their lots **relisted out from under a paid shipping order**. Capture this in the shipping epic so it isn't lost.

---

## Appendix — file:line reference index

**Money / Stripe:** checkout `apps/operator-web/src/app/api/subscriptions/checkout/route.ts:36-41,67-79`; portal `…/subscriptions/portal/route.ts:34`; webhook `…/api/webhooks/stripe/route.ts:636-759`; `ensureProProductAndPrice` `…/lib/stripe.ts:217`; `createConnectAccount` `…/lib/stripe.ts:64`; bidder customer `…/lib/stripe-bidder.ts:29`; setup-intent `…/api/bidder/setup-intent/route.ts:96`; lot-charge PI `…/api/invoices/[id]/payment-intent/route.ts:250`; auto-charge PI `…/lib/cron/auto-charge-drain.ts:373`.
**Perk hooks:** no-show cron `packages/db/migrations/0166_pickup_forfeit.sql:103-113`; grace flip `…/lib/cron/auto-charge-drain.ts:514-528`; grace expiry `…/lib/cron/grace-expiry.ts:55-60`; relist/bid-block `0105_auto_charge_and_relot_fee.sql:333`; slot booking `0007_pickup_slots.sql:176,63-64`; staging `apps/field-mobile/app/(staff)/checkout/stage.tsx`; pickup-verify `…/checkout/pickup-verify.tsx:78,307-342,393-398`.
**Schema / RLS:** subs table + `is_subscriber` `0013_pro_per_org_settlements.sql:35,126`; status enum `0008:50`; RLS helpers `0002_rls.sql:17-49`; H4 role split `0028_security_fixes.sql:158-302`; H3 `0028:317-331`; subquery wrap `0133_rls_subquery_wrap.sql`; operator config `0144_operator_config_columns.sql:36-46`; operator_policies `0088_operator_policies.sql:7-27`; pickup window `0001_init.sql:174-175`.
**Settings UI:** hub `…/(operator)/settings/page.tsx:40-66`; policies triad `…/settings/policies/`; ProTierSection `…/settings/SettingsForm.tsx:284-418`; saveProSettings `…/settings/actions.ts:82-152`.
**Config resolvers:** `useOperatorFeatures` `packages/supabase-client/src/operator-features.ts:37-48`; money helpers `packages/shared/src/money.ts:11,22`.
