# Sentry setup — what you do vs what I've wired

All the code-side wiring is already in place across 3 commits:
- `c7ae6f1` — telemetry routing + `usage.cost` capture from OpenRouter
- `21084a3` — health-check route + cron failure capture
- `2550158` — Sentry `beforeSend` / `beforeBreadcrumb` redaction in server/edge/client configs

The only missing thing is the **DSN values**. I can't create the Sentry account itself
(needs your email + password + 2FA), but everything is set up so that the moment
you paste 3 DSN values, Sentry starts receiving events.

## Step 1 — Create the Sentry account (5 minutes, you do this)

1. Go to https://sentry.io/signup/
2. Sign up with `michael@cluerholdings.com`. Pick a workspace name —
   recommended: `clovrbid` or `gold-run` (matches the operating LLC).
   The free tier covers 5k events/month per project — plenty for now.
3. After confirming email, you'll land in the dashboard. Skip the
   onboarding wizard ("I'll do this later").

## Step 2 — Create 3 projects (5 minutes, you do this)

In Sentry, **Projects → Create Project** for each of:

| Project name | Platform | What it captures |
|---|---|---|
| `clovrbid-web` | Cloudflare Workers (or Node.js if Workers isn't listed) | Operator console errors, webhook failures, pg_cron health check, edge runtime exceptions |
| `clovrbid-staff` | React Native | Field-mobile (currently still labeled "ClovrBid" on the home screen) — JS errors + native crashes from staff devices |
| `clovrbid-bidder` | React Native | ClovrBid bidder app — JS errors + native crashes from bidder devices |

Naming convention: `clovrbid-*` is the umbrella brand for all three
projects. The staff iOS app is still named "ClovrBid" in its current
TestFlight build (will rebrand to "ClovrBid Staff" on the next
field-mobile build); the Sentry project is named for the unified
brand, not the current app label.

For each project, Sentry shows a DSN like:
```
https://<random>@<org>.ingest.us.sentry.io/<project-id>
```

Copy each DSN. You'll paste them into terminal commands below.

## Step 3 — Generate an auth token (for source-map uploads, 2 minutes, you do this)

1. **Settings → Account → API → Auth Tokens → Create New Token**
2. Name: `eas-source-map-upload`
3. Scopes: `project:write`, `project:read`, `project:releases`, `org:read`
4. Copy the token (looks like `sntrys_...`). Treat it like a password.

## Step 4 — I wire the secrets (5 minutes, paste-and-run)

Once you have the 3 DSNs + the auth token, paste them here in any
format that's clear (e.g. `clovrbid-web DSN: https://...`,
`clovrbid-staff DSN: ...`, `clovrbid-bidder DSN: ...`, `auth token:
sntrys_...`). I'll run:

```bash
# Cloudflare Worker secrets (clovrbid-web DSN goes here)
echo "<bidwizops-worker DSN>" | wrangler secret put SENTRY_DSN --name bidwizops
echo "<bidwizops-worker DSN>" | wrangler secret put SENTRY_DSN --name bidwizops-cron

# Field-mobile EAS secrets (mobile crash reporting)
cd apps/field-mobile
eas secret:create --scope project --name EXPO_PUBLIC_SENTRY_DSN --value "<bidwizops-field DSN>" --type string
eas secret:create --scope project --name SENTRY_AUTH_TOKEN --value "<auth token>" --type string

# Bidder-app EAS secrets
cd ../bidder-app
eas secret:create --scope project --name EXPO_PUBLIC_SENTRY_DSN --value "<bidwizops-bidder DSN>" --type string
eas secret:create --scope project --name SENTRY_AUTH_TOKEN --value "<auth token>" --type string
```

I'll also update the operator-web `.env.local` so local dev gets the same DSN.

## Step 5 — Remove `SENTRY_DISABLE_AUTO_UPLOAD` (2 minutes, I do this)

The two mobile apps have `SENTRY_DISABLE_AUTO_UPLOAD=true` baked into every build
profile of `eas.json`. This was the reason Jared's crashes had to be pulled from
ASC TestFlight feedback instead of Sentry. Once the `SENTRY_AUTH_TOKEN` is set as
a project secret in step 4, I'll remove the env-var override so source maps upload
on every build.

## Step 6 — Test the wire (2 minutes, I do this)

After the next Worker deploy:
1. Hit `https://clovrbid.com/api/cron/health-check` with the `x-cron-secret`
   header — if pg_cron has any recent failures it'll captureException.
2. Or trigger a deliberate test exception by adding a `throw new Error('sentry test')`
   to one route, deploying, hitting it, then reverting.

For mobile: trigger a crash via the dev menu (shake → "Throw fatal exception"), or
just wait — Jared has been crashing enough that we'll see traffic naturally.

## What you should see in Sentry after wire

| Event source | Project | Expected within |
|---|---|---|
| Worker exception (any route) | bidwizops-worker | 1 minute |
| pg_cron failure | bidwizops-worker (tagged `check: pg_cron`) | 5 minutes |
| DLQ row in `build_invoice_jobs` | bidwizops-worker (tagged `check: dlq`) | 5 minutes |
| Mobile JS crash | bidwizops-field / bidwizops-bidder | 1 minute |
| Mobile native crash | bidwizops-field / bidwizops-bidder | next app launch + symbolicated stack |
| Stripe webhook failure | bidwizops-worker (tagged `webhook: stripe`) | 1 minute |

## Alert rules I'd suggest setting up (you do this in dashboard)

- **Issue: First occurrence** → email michael@cluerholdings.com
- **Issue: Spike (10x increase)** → email + SMS if you have Twilio integration
- **Issue: tag `check:pg_cron`** → email immediately (auction engine is broken)
- **Issue: tag `webhook:stripe`** → email immediately (money flow is broken)

### AI spend monitoring (metric-based alerts, wired in migration 0085)

The cron route `/api/cron/ai-budget-checks` (runs every 30 min) emits a
`captureMessage` event tagged `metric=ai_hourly_spend` with the estimated
aggregate hourly AI spend across all operators. The event level scales with
spend:

| Level | Threshold | Meaning |
|---|---|---|
| `info` | < $5/hr | Normal |
| `warning` | $5–$20/hr | Elevated — review soon |
| `error` | > $20/hr | High spend — page |

To wire the alert rules in Sentry dashboard:

1. **Alerts → Create Alert Rule → Metric Alert**
2. Dataset: **Error events**
3. Filter: `tag[metric]:ai_hourly_spend AND level:warning`
4. Condition: count > 0
5. Action: Email michael@cluerholdings.com
6. Name: "AI spend > $5/hr"

Repeat for the `error` level rule, action: page (PagerDuty or SMS).

Note: the "hourly" figure is an MTD-average approximation (total billed
MTD / hours into the month). It converges to an accurate trailing average
by ~day 3 of the month. For precise 1-hour windows, the query can be
tightened in `apps/operator-web/src/lib/cron/ai-budget-checks.ts`
(see the TODO comment there).

## Cost

Free tier:
- 5k errors per month per project
- 10k transaction events per project
- 50 replays per month

That covers maybe 10–20 active operators / a few hundred bidders comfortably. Above that, upgrade to Team plan ($26/mo) or pay-as-you-go.

---

**Status: just need the 3 DSNs + auth token from you to finish step 4. Paste them and I'll wire everything.**
