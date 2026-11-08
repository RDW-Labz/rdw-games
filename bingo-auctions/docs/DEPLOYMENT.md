# Production deployment

A linear walkthrough from "I have signups in my pocket" to "live at app.cluerholdings.com." Each section is one external service; do them roughly in this order so dependencies are in place when needed.

> **Total runway**: ~$25/mo Supabase Pro + $99/yr Apple + $25 Google + $5/mo Twilio (if used) + Vercel free + Railway $5/mo + Resend free → ~$150 setup + $35/mo to keep running.

---

## 1. Domain (Cloudflare or registrar of choice)

Pick a primary domain — `cluerholdings.com` is what the app already references. If it's already registered with another registrar, you can either transfer or just point nameservers at Cloudflare for free DNS+SSL.

- Register or transfer the domain.
- Add to Cloudflare (free plan is fine).
- You'll come back to this for DNS records as each service below tells you what to add.

Subdomains we'll use:
- `app.cluerholdings.com` — bidder web (if shipping web alongside mobile) and the universal-link target
- `admin.cluerholdings.com` — operator console (Vercel)
- `api.cluerholdings.com` (optional) — auction-engine, if you want a clean URL for the health endpoint

---

## 2. Apple Developer Program ($99/yr)

Required for App Store + Apple Pay + APNs.

1. Sign up at https://developer.apple.com/programs/. Allow 1–2 days for approval.
2. After approval, go to **Certificates, Identifiers & Profiles**.
3. Create an App ID with bundle identifier `com.cluerholdings.auctionplatform`.
4. Create an Apple Pay Merchant ID: `merchant.com.cluerholdings.auctionplatform` (already referenced in `apps/bidder-app/app.json`).
5. Don't manually create APNs certs — EAS does it for you in step 8.

---

## 3. Google Play Developer ($25 one-time)

Required for Google Play submission.

1. Sign up at https://play.google.com/console/. ID verification can take 1–2 days.
2. Create the app record. Package name: `com.cluerholdings.auctionplatform` (matches `app.json`).
3. Create a service account in Google Cloud → IAM → Service Accounts. Grant it Play Console access. Download the JSON key.
4. Save the JSON as `apps/bidder-app/google-play-service-account.json` — already in `.gitignore`. Path is referenced by `eas.json` for `eas submit`.

---

## 4. Supabase Pro ($25/mo)

Free tier hits connection limits fast under any real load.

1. https://supabase.com → upgrade your existing project to Pro.
2. Apply all migrations:
   ```bash
   cd packages/db
   for f in migrations/*.sql; do
     PGPASSWORD=$DB_PASSWORD psql -h $SUPABASE_DB_HOST -U postgres -d postgres -f $f
   done
   ```
   Or use the Supabase CLI: `supabase db push --linked`.
3. Storage: ensure all four buckets exist (`lot-photos`, `floor-plans`, `dispute-photos`, `staging-photos`, `operator-logos`). They're created by migration 0004 + 0011.
4. Generate the typed Database type: `npm run db:types` (writes to `packages/shared/src/database.types.ts`).
5. Enable Realtime on the tables we subscribe to: `lots`, `bids`, `bin_assignments`. Supabase Dashboard → Database → Replication → toggle these on. (Migration 0017 codifies this for new local dev resets — but a production Supabase project's publication is managed via the dashboard, not the migration, so you'll need to flip the toggles by hand.)

Save these to a password manager — you'll paste them everywhere:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

---

## 5. Stripe (live mode)

You're using a Stripe test account already. For prod:

1. Go to https://dashboard.stripe.com → Activate Account (you'll need EIN, bank, ID).
2. Connect → Settings → enable Express accounts.
3. Identity → Settings → enable.
4. Tax → Settings → enable + add nexus jurisdictions (start with the state your warehouse is in).
5. Webhooks → Add endpoint → `https://admin.cluerholdings.com/api/webhooks/stripe`. Subscribe to:
   - `account.updated`
   - `payment_intent.succeeded` / `payment_intent.payment_failed`
   - `charge.refunded`
   - `customer.subscription.created` / `.updated` / `.deleted`
   - `identity.verification_session.verified` / `.requires_input`
6. Copy the webhook signing secret → `STRIPE_WEBHOOK_SECRET`.
7. Get live keys → `STRIPE_SECRET_KEY` (sk_live_…) and `STRIPE_PUBLISHABLE_KEY` (pk_live_…).

Operator Pro Prices are created automatically by `ensureProProductAndPrice` when an operator enables Pro.

---

## 6. Resend (email)

Free tier: 3,000 emails/month. Plenty for the pilot.

1. Sign up at https://resend.com.
2. Domains → Add Domain → `cluerholdings.com`.
3. Resend gives you DNS records to add — DKIM, SPF, return-path. Add them all to Cloudflare.
4. Wait 10 minutes, hit Verify in Resend.
5. API Keys → create one → `RESEND_API_KEY`.
6. Set `RESEND_FROM_EMAIL` to e.g. `"ClovrBid <no-reply@clovrbid.com>"`. The display name shows in inboxes.

Without DKIM, every email lands in spam. **Don't skip this step.**

---

## 7. Twilio (SMS) — optional but recommended

Skip if you're staying push-and-email only. Otherwise:

1. Sign up at https://www.twilio.com. Verify a personal phone for 2FA.
2. Console → Phone Numbers → Buy a number ($1.15/mo). Pick a 10DLC-eligible US local number.
3. Messaging → Services → Create Messaging Service. Add the number. **Register a 10DLC campaign** under it — without this, US carriers block bulk messages.
4. Account SID + Auth Token from the dashboard → `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
5. Either use the messaging service SID (`TWILIO_MESSAGING_SERVICE_SID`) or the bare phone number (`TWILIO_FROM_PHONE`) in env. Service SID is preferred — gives delivery analytics + lets you swap numbers later.

10DLC registration takes a week or two for approval. Until it's approved, only verified test numbers can receive SMS.

---

## 8. Expo / EAS (mobile build + submit)

1. https://expo.dev → sign in.
2. From `apps/bidder-app`: `eas init` — claims the project, fills in `extra.eas.projectId` in `app.json`. Commit that change.
3. Push credentials:
   ```bash
   eas credentials -p ios   # APNs key — EAS generates it via your Apple Developer account
   eas credentials -p android # FCM server key — paste from Firebase / Google Cloud
   ```
4. Set production secrets (these won't be in `.env`, they live in EAS):
   ```bash
   eas secret:create --name EXPO_PUBLIC_SUPABASE_URL --value "https://..."
   eas secret:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "..."
   eas secret:create --name EXPO_PUBLIC_API_BASE_URL --value "https://admin.cluerholdings.com"
   eas secret:create --name EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY --value "pk_live_..."
   eas secret:create --name EXPO_PUBLIC_SENTRY_DSN --value "https://..."
   eas secret:create --name SENTRY_AUTH_TOKEN --value "..."  # for source-map upload
   ```
5. Build internal preview:
   ```bash
   eas build -p ios --profile preview
   eas build -p android --profile preview
   ```
6. Submit when ready:
   ```bash
   eas submit -p ios --latest
   eas submit -p android --latest
   ```

See `apps/bidder-app/STORE-SUBMISSION.md` for the full pre-submission checklist (Apple IAP rule for subscriptions, privacy nutrition labels, Data Safety form).

---

## 9. Upstash Redis (production BullMQ)

1. https://upstash.com → create a Redis database → "Global" replication, free tier.
2. Copy the **TLS** connection URL (starts with `rediss://`, not `redis://`). BullMQ requires the s.
3. Save as `REDIS_URL`.

Free tier handles ~10K commands/day — plenty for the pilot. Watch the dashboard if you scale.

---

## 10. Vercel (operator-web)

1. https://vercel.com → import the GitHub repo.
2. **Project root**: `apps/operator-web`.
3. **Framework**: Next.js (auto-detected).
4. The repo's `vercel.json` already configures the monorepo build command; no manual override needed.
5. **Environment variables** (Production):
   ```
   NEXT_PUBLIC_SUPABASE_URL
   NEXT_PUBLIC_SUPABASE_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY
   STRIPE_SECRET_KEY
   STRIPE_PUBLISHABLE_KEY
   STRIPE_WEBHOOK_SECRET
   REDIS_URL
   SENTRY_DSN
   NEXT_PUBLIC_SENTRY_DSN
   NEXT_PUBLIC_POSTHOG_KEY
   NEXT_PUBLIC_POSTHOG_HOST   # https://us.i.posthog.com (or eu)
   ```
6. **Domains**: add `admin.cluerholdings.com`. Vercel gives you a CNAME to add to Cloudflare.
7. Deploy. First build takes ~3 minutes.
8. After deploy, go back to Stripe → Webhooks → confirm the endpoint URL points at `admin.cluerholdings.com/api/webhooks/stripe`.

---

## 11. Railway (auction-engine)

1. https://railway.app → New Project → Deploy from GitHub repo.
2. Root directory: leave blank (Dockerfile path is in `railway.toml`).
3. Service → Settings → set **Root Directory** to `/` (so the Docker build context is the monorepo root).
4. Service → Settings → **Watch Paths**: `packages/auction-engine/**`, `packages/shared/**`. Avoids redeploying when only operator-web changes.
5. **Environment variables**:
   ```
   SUPABASE_URL
   SUPABASE_SERVICE_ROLE_KEY
   REDIS_URL
   SENTRY_DSN
   STRIPE_SECRET_KEY
   RESEND_API_KEY
   RESEND_FROM_EMAIL
   PUBLIC_APP_URL=https://app.cluerholdings.com
   TWILIO_ACCOUNT_SID
   TWILIO_AUTH_TOKEN
   TWILIO_MESSAGING_SERVICE_SID
   ```
6. Deploy. Watch logs for "auction-engine workers starting" and "health server listening on 3100".
7. Health check at `https://<service>.up.railway.app/health` should return `{ "ok": true }`.

Optional: assign `api.cluerholdings.com` as a custom domain in Railway's networking tab.

---

## 12. Sentry + PostHog

Both are optional but cheap insurance. Both have free tiers covering the pilot.

**Sentry**:
1. https://sentry.io → create project per app: `operator-web`, `bidder-app`, `auction-engine`.
2. Copy each DSN into the matching `SENTRY_DSN` (or `EXPO_PUBLIC_SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`).
3. For source-map upload during EAS builds, create an Auth Token under Settings → Auth Tokens with `project:releases` scope.

**PostHog**:
1. https://posthog.com → create project.
2. Get the API key → `NEXT_PUBLIC_POSTHOG_KEY` and `EXPO_PUBLIC_POSTHOG_KEY`.

---

## 13. After-deploy smoke test

Walk through `docs/SMOKE-TEST.md` against the live URLs. Pay special attention to:
- Stripe webhook delivery (Vercel logs + Stripe dashboard → Webhooks → recent attempts)
- Email DKIM verification (send yourself a test from `/profile` save → check email headers for `dkim=pass`)
- Real-device push (TestFlight + Play Internal Testing both pre-store)
- Settlements: the worker fires every 60s; manually expire one with `UPDATE operator_settlements SET release_at=now() WHERE id='...'` and watch logs

---

## 14. Costs at a glance

| Service | Tier | Monthly |
|---|---|---|
| Domain | varies | ~$1/mo |
| Apple Developer | Annual | $8.25/mo |
| Google Play | One-time | — |
| Supabase | Pro | $25 |
| Stripe | Pay per txn (2.9% + 30¢) | $0 base |
| Resend | Free (3K/mo) | $0 |
| Twilio (optional) | Per msg + $1.15/mo number | ~$5–20 |
| Upstash | Free | $0 |
| Vercel | Hobby | $0 |
| Railway | Pro | $5+ |
| Sentry | Free (5K events/mo) | $0 |
| PostHog | Free (1M events/mo) | $0 |

Pilot total: **~$45/month** + Stripe transaction fees + first-year Apple ($99). When you cross Resend/Twilio free tiers or hit Vercel's 100GB bandwidth, that's the signal you have real users.

---

## What's still your job

- File any state auctioneer license requirements before operators go live.
- Have an attorney review `legal/*.md` before publishing.
- Set up monitoring alerts (BetterStack / Pingdom on `/health` URLs).
- Configure Stripe Tax nexus per state your warehouses are in.
- Apple Pay merchant ID needs an associated domain file at `.well-known/apple-developer-merchantid-domain-association` if accepting Apple Pay on web (mobile uses native flow).
