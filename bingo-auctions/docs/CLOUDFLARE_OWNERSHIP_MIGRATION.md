# Cloudflare ownership migration

Migrate the production Cloudflare account (currently owned by IT guy) to
the user's own Cloudflare account, signed in with the same Google login
that already owns GitHub, Supabase, and InsForge.

**Why now:** TestFlight build 5 isn't installed yet, no bidder traffic.
This is the cheapest possible migration window. Once real bidders are
hitting `clovrbid.com`, every minute of mis-routed DNS becomes
a support ticket. Today, the worst case is the user can't load the
operator console for a few minutes — annoying but recoverable.

**End state:** Everything under the user's Google account. IT guy's
Cloudflare account no longer has anything related to ClovrBid.

---

## Pre-flight (10 min, do BEFORE migration day)

### A. Confirmed facts about cluerholdings.com (from RDAP/DNS public lookups)

- **Registrar: GoDaddy.com, LLC** ✓ — simple path, just change
  nameservers at GoDaddy
- **Domain registered**: 2024-10-16, expires 2026-10-16
- **Current nameservers**: `nitin.ns.cloudflare.com`,
  `sara.ns.cloudflare.com` (IT guy's CF account)
- **Email is Microsoft 365** — MX → `cluerholdings-com.mail.protection.outlook.com`.
  Preserve MX + SPF + DKIM + DMARC exactly during DNS migration or
  email breaks for the whole org.
- **Live subdomains visible from outside DNS:**
  - `www.cluerholdings.com` (CF IP — likely marketing or redirect)
  - `clovrbid.com` (bidwizops Worker)
  - `ollama.cluerholdings.com` (CF IP — possible 3090 Cloudflare Tunnel,
    verify with IT guy below)
- **GoDaddy status flags** (clientDelete/Renew/Transfer/UpdateProhibited):
  these are default GoDaddy locks for INTER-registrar actions. They do
  NOT block changing nameservers via the GoDaddy dashboard. Good news.

### B. Need user's GoDaddy login

Domain DNS settings live at GoDaddy. The user needs to be able to log
in there to change the nameservers in Phase 3.

If unsure of the GoDaddy account creds — recover them BEFORE migration
day. Last thing you want is a Saturday-evening password-reset cascade.

### C. Get IT guy to do four things

All small asks; he doesn't need to be present during the actual cutover:

1. **Export the DNS zone** for cluerholdings.com as a BIND zone file.
   Cloudflare dashboard → cluerholdings.com → DNS → Records → Advanced
   → Export DNS records. Send it to you (gitignored, save to
   `.cloudflare-migration/dns-export.txt` locally). This will reveal
   any subdomains beyond the 3 visible from outside DNS.

2. **List of Workers** on the account that touch ClovrBid. At minimum:
   `bidwizops` (operator-web) and any others (he should confirm
   there's nothing else like `bidwizops-cron` if it got deployed via
   the bridge path earlier).

3. **Dump of all secrets** set on `bidwizops`. He runs (from his
   wrangler shell):

   ```bash
   npx wrangler secret list
   ```

   This prints names only (no values). Send you the list. You'll need
   to re-populate the values from your local `.env*.local` files; the
   values themselves should already be in your repo's gitignored env
   files (per the previous SESSION_HANDOFF.md, all secrets are stored
   locally).

4. **Cloudflare Tunnel inventory.** External DNS shows
   `ollama.cluerholdings.com` resolving to a Cloudflare IP — most
   likely a Cloudflare Tunnel from the 3090 box, even though the prior
   session handoff said "tunnel not set up." Ask:

   *"Is there a Cloudflare Tunnel configured for ollama.cluerholdings.com
   or any other subdomain? If yes, what's the tunnel ID and is the
   cloudflared service actually running anywhere (3090 box?), or is
   the DNS just a stub from earlier setup?"*

   If a real tunnel exists, see "Phase 5: Cloudflare Tunnel
   migration" below.

### D. Confirm the secret values you have

Cross-check the secret names IT guy sent against your local env files.
You need values for at least:
- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from `apps/operator-web/.env.local`)
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PUBLISHABLE_KEY`
- `SENTRY_DSN`
- `NEXT_PUBLIC_POSTHOG_KEY`
- `OPENROUTER_API_KEY`
- `REDIS_URL` (stale, can skip — being deleted with auction-engine)
- Anything else his `wrangler secret list` shows

If any are missing locally, ask IT guy to send those specific values via
a secure channel (1Password share, encrypted note — NOT chat).

---

## Phase 1: Stand up parallel infra (45 min, ZERO impact on production)

Nothing in this phase touches the live site. You're building a shadow
of the production setup on your own account. Production keeps serving
from IT guy's CF until Phase 3.

### 1. Create your Cloudflare account

```
https://dash.cloudflare.com/sign-up
```

Sign in with Google — same Google account that owns GitHub/Supabase/InsForge.
Verify email if prompted.

### 2. Generate API token for wrangler

Cloudflare dashboard → My Profile → API Tokens → Create Token:
- Template: "Edit Cloudflare Workers"
- Permissions: Workers Scripts:Edit, Account Settings:Read, Zone:Read, DNS:Edit
- Account: your-account
- Zone Resources: All zones on account
- TTL: leave default (or set 90 days)

Save the token (you'll see it once). Set as env var locally:

```bash
# Inside WSL Ubuntu:
echo 'export CLOUDFLARE_API_TOKEN=<paste-token>' >> ~/.bashrc
source ~/.bashrc
```

Verify:

```bash
cd /mnt/c/Users/jmacl/Projects/auction-platform
npx wrangler whoami
# Should print your email + account ID
```

### 3. Add cluerholdings.com as a zone in your new account

In your CF dashboard → Add a Site → enter `cluerholdings.com` → Free plan
(you can upgrade later). Cloudflare will:

- Attempt to scan existing DNS — let it; you'll re-import properly in
  step 4
- Show you the **2 nameservers** to use (e.g.
  `xxx.ns.cloudflare.com`, `yyy.ns.cloudflare.com`). Write these down.

**DO NOT change nameservers at the registrar yet.** That happens in
Phase 3.

### 4. Import DNS records from IT guy's export

Cloudflare dashboard → cluerholdings.com → DNS → Records → Advanced →
Import DNS records → paste the BIND zone file from IT guy.

After import, **audit**:

```bash
# Compare: yours vs IT guy's export
diff <(curl -sH "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
       "https://api.cloudflare.com/client/v4/zones/<YOUR_ZONE_ID>/dns_records?per_page=100" \
       | jq -r '.result[] | "\(.type) \(.name) \(.content)"' | sort) \
     <(grep -v '^;' .cloudflare-migration/dns-export.txt | \
       awk 'NF>=4 {print $4, $1, $5}' | sort)
```

(Adjust the second awk to match the BIND file format if needed.)

**Audit specifically:**
- A / AAAA records for any subdomains
- CNAME records (esp. for any third-party services)
- MX records (email — if missing, email breaks at cutover)
- TXT records for SPF / DKIM / DMARC (email deliverability)
- TXT records for domain verification (Resend, Twilio, etc.)
- Workers routes: ANY/ANY record for `clovrbid.com`,
  `*.cluerholdings.com`, etc.

If anything is missing, add it manually before proceeding.

### 5. Deploy `bidwizops` Worker to your account

```bash
cd /mnt/c/Users/jmacl/Projects/auction-platform/apps/operator-web

# Build the OpenNext bundle:
npm run cf:build

# Deploy to your account:
npx wrangler deploy
# This uses the wrangler.jsonc — Worker name is `bidwizops`. Will create
# it under your account since you're authenticated as yourself.
```

### 6. Deploy `bidwizops-cron` Worker

```bash
cd /mnt/c/Users/jmacl/Projects/auction-platform/apps/cron-trigger
npx wrangler deploy
```

### 7. Set all secrets on YOUR Workers

```bash
cd /mnt/c/Users/jmacl/Projects/auction-platform/apps/operator-web

# Run scripts/cloudflare-cutover.sh — it pushes every env var from
# .env.cloudflare-import.local to the Worker. Same script used for
# the original cutover; it's idempotent.
bash ../../scripts/cloudflare-cutover.sh
```

Plus the new cron secret:

```bash
# Generate and set CRON_SECRET on both workers:
CRON_SECRET=$(openssl rand -hex 32)
echo $CRON_SECRET > .cloudflare-migration/cron-secret.txt  # save for cleanup later

cd ../operator-web
echo "$CRON_SECRET" | npx wrangler secret put CRON_SECRET

cd ../cron-trigger
echo "$CRON_SECRET" | npx wrangler secret put CRON_SECRET
echo "https://clovrbid.com" | npx wrangler secret put CRON_TARGET_URL
```

### 8. Configure Worker route bindings

In your CF dashboard → Workers & Pages → bidwizops → Settings →
Triggers → Custom Domains → add `clovrbid.com`.

**At this point Cloudflare will refuse** because the zone is still on
IT guy's nameservers. That's expected. You can either:

- Skip this step now and add the custom domain right after the
  nameserver switch in Phase 3, OR
- Add `clovrbid.com` as a *route* (not a custom domain) — that
  works even before nameserver cutover, but only kicks in once DNS
  resolves to your CF

Easier: do this in Phase 3.

---

## Phase 2: Pre-cutover smoke test (15 min, ZERO impact)

You now have a fully-configured shadow setup. Verify it works before
flipping nameservers.

### 1. Get your Worker's preview URL

```bash
cd /mnt/c/Users/jmacl/Projects/auction-platform/apps/operator-web
npx wrangler deployments list
# Get the deployment URL — something like
# https://bidwizops.<your-subdomain>.workers.dev
```

Wait — note in the existing `wrangler.jsonc` we set `"workers_dev": false`.
So preview URL won't work without flipping that temporarily. Two options:

**Option A:** Temporarily enable workers.dev URL:

```bash
# Edit apps/operator-web/wrangler.jsonc:
# "workers_dev": true,  (was false)
# "preview_urls": true,  (was false)

npx wrangler deploy
# Now you can hit https://bidwizops.<your-handle>.workers.dev
# REMEMBER to flip back to false after testing.
```

**Option B:** Hit it via a temporary subdomain. In your CF dashboard, add
a DNS record `staging.cluerholdings.com` (orange-clouded, A 1.1.1.1)
and route `staging.cluerholdings.com/*` to your bidwizops Worker.
**This requires nameserver switch first**, so doesn't help here.

Go with Option A.

### 2. Test the Worker via workers.dev URL

```bash
WORKERS_DEV_URL="https://bidwizops.<your-handle>.workers.dev"

# Smoke tests:
curl -I "$WORKERS_DEV_URL"           # 200 OK
curl "$WORKERS_DEV_URL" | head -50   # HTML, see operator login page

# Test an API route:
curl "$WORKERS_DEV_URL/api/healthz" 2>&1 | tail
# If this route doesn't exist yet, try the home page
```

### 3. Test the cron trigger Worker

```bash
cd ../cron-trigger
npx wrangler tail
# Wait 60 seconds. You should see scheduled events firing with
# "no paths configured" warnings (since the routes haven't moved yet)
# or successful POSTs to the workers.dev URL if you set CRON_TARGET_URL
# to that instead.
```

You can temporarily set `CRON_TARGET_URL` to the workers.dev URL during
test, then flip it to `https://clovrbid.com` after Phase 3
cutover.

### 4. Revert workers.dev = false

After testing, flip `wrangler.jsonc` back:

```jsonc
"workers_dev": false,
"preview_urls": false,
```

```bash
npx wrangler deploy
```

---

## Phase 3: Cutover (10 min active + 1-24h propagation)

This is the moment of switch. After this, DNS slowly migrates from IT
guy's CF to yours. Most users will see the new Worker within minutes
because Cloudflare's NS TTLs are short.

### 1. Change nameservers at GoDaddy

Log into GoDaddy → My Products → cluerholdings.com → DNS → Nameservers
→ Change.

**Current (IT guy's CF):**
- `nitin.ns.cloudflare.com`
- `sara.ns.cloudflare.com`

**Replace with your CF nameservers** from Phase 1 step 3 (they'll be
different `<name>.ns.cloudflare.com` pairs assigned to your account).

Save changes. GoDaddy may show a warning about changing nameservers —
confirm it.

**Particularly verify the MX records survived the migration** because
the Cluer org's Microsoft 365 email depends on:
- `MX: cluerholdings-com.mail.protection.outlook.com` (priority 0)
- TXT `v=spf1 include:spf.protection.outlook.com -all`
- DKIM TXT records (selectors typically `selector1._domainkey.cluerholdings.com`
  and `selector2._domainkey.cluerholdings.com`)
- DMARC TXT at `_dmarc.cluerholdings.com` if configured

These should all be in the BIND export from Phase 1. Audit them
specifically — losing any of these breaks org email.

### 2. Watch propagation

```bash
# Check nameservers from multiple resolvers:
dig @8.8.8.8 cluerholdings.com NS +short      # Google DNS
dig @1.1.1.1 cluerholdings.com NS +short      # Cloudflare DNS
dig @9.9.9.9 cluerholdings.com NS +short      # Quad9

# Resolve ops subdomain:
dig @8.8.8.8 clovrbid.com +short

# Should see your new CF Worker IP (or CNAME chain) within 5-30 minutes.
# Full propagation can take up to 24h for some ISPs.
```

In your CF dashboard, the zone will show "Pending" until NS propagation
completes — at which point you'll get an email and the status flips to
"Active".

### 3. Add `clovrbid.com` as a Custom Domain

Once the zone is "Active" in your CF dashboard:

CF dashboard → Workers & Pages → bidwizops → Settings → Triggers →
Custom Domains → Add Custom Domain → `clovrbid.com` → Add.

Same for any other custom domain (`app.cluerholdings.com` if it's a
worker-served subdomain, etc. — check what IT guy had configured).

### 4. Verification (within 10 min of NS active)

```bash
# Test live URL — should now hit YOUR worker:
curl -I https://clovrbid.com

# Confirm the Worker version in CF dashboard matches your latest deploy:
cd /mnt/c/Users/jmacl/Projects/auction-platform/apps/operator-web
npx wrangler deployments list
# Latest "Active" deployment should be one of yours.
```

Run the auction-engine end-to-end test (the 2-min test auction from
`docs/AUCTION_ENGINE_DEPLOY.md` §Verify) to confirm pg_cron drains
through the new Worker.

### 5. Verify external integrations

These all hit `https://clovrbid.com` from outside; once DNS
points to your Worker they should continue working without any reconfig
on the external side:

- [ ] **Stripe webhooks**: Stripe Dashboard → Developers → Webhooks →
      find the endpoint for `clovrbid.com/api/webhooks/stripe`
      → "Send test webhook" → should return 200
- [ ] **Mobile API**: Build 5 (when installed) points at
      `clovrbid.com` — try a Quick Lot AI scan, check
      `ai_calls` table for new row
- [ ] **Email delivery (if Resend is wired)**: send a test email →
      check it arrives. SPF/DKIM should still be valid since DNS records
      were imported in Phase 1.
- [ ] **Apple Universal Links** (if any): try a deep link → opens
      app, not Safari. AASA file served at
      `https://app.cluerholdings.com/.well-known/apple-app-site-association`
      should be identical to what IT guy's Worker served.

---

## Phase 4: Cleanup (next day, after 24h of stable propagation)

Wait 24 hours after the nameserver switch — propagation tail might keep
sending a small percentage of traffic to IT guy's NS until then. Don't
delete the old Worker prematurely or you'll get sporadic 404s for the
laggards.

### 1. Confirm propagation is complete

```bash
# Check from ~5 different public resolvers:
for ns in 8.8.8.8 1.1.1.1 9.9.9.9 208.67.222.222 4.2.2.2; do
  echo "=== $ns ==="
  dig @$ns cluerholdings.com NS +short
done

# All five should show YOUR nameservers, not IT guy's.
```

### 2. IT guy removes the old infra

Send him this checklist:

> "Migration complete. To finish cleanup on your CF account:
> 1. Workers & Pages → delete the `bidwizops` Worker
> 2. Workers & Pages → delete `bidwizops-cron` Worker if it's there
> 3. Websites → cluerholdings.com → Advanced Actions → "Remove site
>    from Cloudflare" (the zone is now on my account anyway)
> 4. If you added me as a member, you can remove me now — I don't
>    need access anymore"

### 3. Rotate secrets

Anything that was set on IT guy's Worker is technically still on his
account (just no longer wired up). For peace of mind, rotate the
sensitive ones:

- Stripe webhook signing secret (Stripe Dashboard → Webhooks → roll
  signing secret)
- Supabase service role key (Supabase Dashboard → Settings → API → reset)
- Any other API keys you'd be uncomfortable having on his account

Update the rotated values in your `.env.cloudflare-import.local` AND
push them to your new Worker:

```bash
cd apps/operator-web
echo "<new-stripe-webhook-secret>" | npx wrangler secret put STRIPE_WEBHOOK_SECRET
# repeat for any rotated key
```

### 4. Document the new state

Update `docs/CLOUDFLARE_STATE.md`:
- Account: your-google-email
- API Token storage: `~/.bashrc` in WSL (or 1Password)
- Workers list: `bidwizops`, `bidwizops-cron`
- Zone owner: your account

Delete this `CLOUDFLARE_OWNERSHIP_MIGRATION.md` doc OR keep it as
historical reference. Once IT guy's CF no longer touches anything,
this doc has served its purpose.

### 5. Update memory

Edit
`C:\Users\jmacl\.claude\projects\C--Users-jmacl-Projects\memory\auction_platform_cloudflare_ownership.md`
— set to "MIGRATED on 2026-XX-XX" or just delete it (the constraint no
longer applies).

---

## Phase 5: Cloudflare Tunnel migration (only if applicable)

If pre-flight reveals a real Cloudflare Tunnel running (e.g.
`ollama.cluerholdings.com` → 3090 box via cloudflared), it needs its
own migration because Tunnels are per-account.

### 1. On IT guy's CF account, document the tunnel

Cloudflare dashboard → Zero Trust → Networks → Tunnels → find the
tunnel for `ollama.cluerholdings.com`. Note:
- Tunnel name + ID
- Public hostnames it serves
- Service that's running behind it (Ollama on the 3090 = `http://localhost:11434` or similar)

### 2. On YOUR CF account, create an equivalent tunnel

CF dashboard → Zero Trust → Networks → Tunnels → Create a tunnel.
- Name it `bidwizops-ollama` or similar
- Install cloudflared on the 3090 box
- Add public hostname → `ollama.cluerholdings.com` → service
  `http://localhost:11434`

### 3. Switch cloudflared on the 3090 to the new tunnel token

On the 3090 box (Windows): stop the cloudflared service (Services.msc),
update its credentials file (`%ProgramData%\Cloudflare\cloudflared\<old-uuid>.json`
→ replace with new tunnel's JSON), restart the service.

OR: uninstall the old cloudflared service entirely, reinstall with the
new tunnel command (from CF dashboard, the "Run" tab gives a copy-pasteable
PowerShell command).

### 4. Delete the old tunnel from IT guy's CF account

After confirming the new tunnel is serving traffic.

### Alternative if the DNS is just a stub

If pre-flight reveals the DNS record exists but no cloudflared is
running anywhere (which matches the prior handoff's "tunnel not set
up"), then there's nothing to migrate here — the DNS record will come
over with the Phase 1 zone file import and stay parked until you
actually set up the tunnel later.

---

## Rollback plan

If the cutover goes sideways and you can't get `clovrbid.com`
serving correctly within 30 minutes, you can roll back by:

1. **Re-change nameservers at the registrar** back to IT guy's CF
   nameservers (still active until Phase 4 cleanup deletes them)
2. Wait for DNS to revert — same propagation, 5min-24h
3. Production traffic flows back to IT guy's Worker as before

This is why Phase 4 cleanup is **24+ hours after Phase 3**, not
immediate: IT guy's CF infra stays alive as a rollback target during
the propagation window.

---

## Timeline summary

| Phase | Duration | Production impact |
|---|---|---|
| Pre-flight | 10 min over Slack | None |
| Phase 1 (prep) | 45 min focused | None |
| Phase 2 (smoke test) | 15 min | None |
| Phase 3 (cutover) | 10 min active + 1-24h propagation | Brief routing flicker for some clients (no real bidders right now → no real impact) |
| Phase 4 (cleanup) | 30 min next day | None |

**Total focused-attention time: ~2 hours, plus a propagation wait.**

---

## What this migration does NOT do

- **Does not transfer the domain registration** if it's at Cloudflare
  Registrar. That's a 60-day-aged transfer with EPP auth code; do it
  separately later if you want.
- **Does not migrate Cloudflare Tunnel** for the 3090 Ollama box —
  that's not set up yet anyway per the prior session handoff.
- **Does not change Stripe / Supabase / InsForge / GitHub ownership** —
  those are already on user's Google.

---

## Bridge approach (only if you need to ship auction-engine BEFORE migrating)

If the migration timeline doesn't work for some reason, see the
"Cloudflare member invite" approach in
`docs/AUCTION_ENGINE_DEPLOY.md` — IT guy can grant you member access
to his CF account in 2 minutes, which unblocks deploys without doing
the full migration. Then migrate later.
