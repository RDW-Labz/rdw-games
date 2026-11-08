# Cloudflare migration — final state (2026-05-11)

Where the platform sits right now after the Vercel → Cloudflare move.

## Production URLs

| Surface | URL | Host |
|---|---|---|
| **operator-web (canonical)** | https://clovrbid.com | Cloudflare Workers |
| operator-web (backup) | https://project-9ymiy.vercel.app | Vercel (still alive, instant rollback) |
| Supabase | xgsujdzicnjenhqihovk.supabase.co | (unchanged) |
| Mobile field-mobile (TestFlight prod) | — | currently hits Vercel; new build queued |
| Mobile bidder-app | — | local dev value in .env; production uses EAS Secrets |

## What's live on Cloudflare Workers

- **Project name:** `bidwizops`
- **Account:** `82bbd89ae113151d3817ccbad1155fcd` (Shadetreerocketsurgeon84@gmail.com)
- **Plan:** Workers Paid ($5/mo) — needed for the 10 MiB compressed-script ceiling
- **Bundle size:** 3.5 MiB gzip (well under 10 MiB ceiling)
- **Cold start:** ~50 ms
- **Compatibility flags:** `nodejs_compat`
- **workers.dev URL:** disabled (returns 404)
- **Custom domain:** `clovrbid.com` with auto-provisioned Cloudflare SSL

## Env vars / secrets on Cloudflare Workers

| Name | Type | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | plain_text | baked at build, also runtime |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | plain_text | same |
| `NEXT_PUBLIC_SENTRY_DSN` | plain_text | client-side error reporting |
| `NEXT_PUBLIC_POSTHOG_KEY` | plain_text | analytics |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | server-side admin client |
| `SENTRY_DSN` | secret | server-side error reporting |
| `REDIS_URL` | secret | BullMQ producer (close-lot + cache-warm queues) |
| `OPENROUTER_API_KEY` | secret | all AI calls |
| `ALLOW_SKIP_STRIPE_ONBOARDING` | secret | currently `true` |

**Removed:** `ANTHROPIC_API_KEY` (legacy direct-Anthropic path was dead code; cleaned up in commit f4c7df9 + removed from Vercel env).

## Supabase Auth config

```json
{
  "site_url": "https://clovrbid.com",
  "uri_allow_list": "https://clovrbid.com,https://clovrbid.com/**,https://clovrbid.com/auth/callback,https://project-9ymiy.vercel.app,https://project-9ymiy.vercel.app/**,bidwizops://*,bidwizops://,auctionplatform://*,auctionplatform://"
}
```

Both domains in allow_list during the soak period so a rollback DNS swap doesn't break magic-link emails.

## Mobile state

`apps/field-mobile/.env` and `eas.json` updated:

```
EXPO_PUBLIC_API_BASE_URL=https://clovrbid.com
```

**EAS Build queued at 2026-05-11:** `a26226ab-8d15-4964-b124-fc19fff28ef9`
- Build dashboard: https://expo.dev/accounts/rdw_cluer/projects/bidwizops-field/builds/a26226ab-8d15-4964-b124-fc19fff28ef9
- Profile: `preview` (TestFlight beta channel)
- Build time: ~15-30 minutes
- After build completes: `eas submit -p ios --profile preview` to push to TestFlight, then install the update on the picker phone.

**Until that build lands**, mobile API calls still hit Vercel. Vercel is still alive serving the same code, so nothing is broken.

## How to deploy from here on out

```bash
# Web (Cloudflare Workers):
wsl -d Ubuntu
cd /mnt/c/Users/jmacl/Projects/auction-platform/apps/operator-web
CLOUDFLARE_API_TOKEN=<token> npm run cf:deploy

# Cleaner re-deploy with build + deploy in one step:
CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
# (Wrangler detects opennextjs and runs the build automatically.)
```

To set/update a Cloudflare secret:
```bash
echo "value" | npx wrangler secret put VAR_NAME
```

To roll back to Vercel in an emergency:
```bash
# 1. Revert Supabase Site URL via Management API
TOKEN=$(grep "^SUPABASE_ACCESS_TOKEN=" /mnt/c/Users/jmacl/Projects/auction-platform/.env.migrations.local | cut -d= -f2-)
REF=$(grep "^SUPABASE_PROJECT_REF=" /mnt/c/Users/jmacl/Projects/auction-platform/.env.migrations.local | cut -d= -f2-)
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -d '{"site_url":"https://project-9ymiy.vercel.app"}'

# 2. Point clovrbid.com DNS at Vercel (or remove the custom domain
#    binding from Cloudflare so it falls back to Vercel via DNS).
```

## What still needs doing (your hands)

1. **Smoke-test clovrbid.com** — sign in, click around inventory/lotting/staff/auctions. Confirm parity with the Vercel version.
2. **Wait for EAS Build** (~15-30 min from 2026-05-11 ~21:30 UTC). Watch the URL above.
3. **`eas submit` the new build to TestFlight** when ready.
4. **Install the update on your phone**, hit a Quick Lot scan, confirm `ai_calls` shows the new requests landing.
5. **(Separately) 3090 Ollama tunnel** — see `docs/CLOUDFLARE_CUTOVER.md` §6. Set `LLM_OLLAMA_BASE_URL` + per-task `LLM_PROVIDER_*` env vars on Cloudflare to start routing AI calls through your local 3090.
6. **Eventually retire Vercel** once you've been on Cloudflare 1-2 weeks without surprises. Hobby plan stays $0 so no urgency.

## Files that changed during the migration

```
apps/operator-web/wrangler.jsonc        # Cloudflare Worker config
apps/operator-web/open-next.config.ts   # OpenNext build config
apps/operator-web/package.json          # cf:build/cf:deploy scripts + opennext devdeps
apps/operator-web/src/app/(operator)/lottr/page.tsx           # OPENROUTER (was ANTHROPIC)
apps/operator-web/src/app/(operator)/lottr/queue/page.tsx     # same
apps/operator-web/src/app/api/lottr/*/route.ts (×5)           # dropped anthropic config writes
apps/field-mobile/.env                  # API base URL → clovrbid.com
apps/field-mobile/eas.json              # API base URL → clovrbid.com (all 3 profiles)
scripts/cloudflare-cutover.sh           # one-shot cutover automation
docs/CLOUDFLARE_CUTOVER.md              # runbook
docs/CLOUDFLARE_STATE.md                # this file
.gitignore                              # .open-next/ + .wrangler/
.env.cloudflare-import.local            # (gitignored) env values used for build
```

Commits, oldest first:
- `115ea78` operator-web: Cloudflare Pages prep
- `07dbab6` scripts: one-command Cloudflare cutover automation
- `e12416a` Cloudflare Workers: custom domain clovrbid.com
- `f4c7df9` Drop dead ANTHROPIC_API_KEY refs across API routes + UI
- `8ccc99b` field-mobile: point API base URL at clovrbid.com
