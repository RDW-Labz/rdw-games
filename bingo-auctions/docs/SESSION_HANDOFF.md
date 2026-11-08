# Session handoff — ClovrBid Staff platform

Last updated 2026-05-12 ~22:30 UTC by the previous Claude Code session.

---

## TL;DR — the big news

**The new auction-engine is LIVE in production.** BullMQ + Redis + Railway is dead; pg_cron + Cloudflare cron Worker is alive. Verified end-to-end with real push notifications delivered via Expo Push during the session. Zero added monthly cost.

`packages/auction-engine/` has been deleted (it never deployed anywhere). Stripe Connect was migrated from legacy Express to **Accounts v2 controller-properties Standard equivalent**.

---

## Where we work

Monorepo at `C:\Users\jmacl\Projects\auction-platform`. Four apps:

| App | Path | Deploy target | Status |
|---|---|---|---|
| **operator-web** | `apps/operator-web` | Cloudflare Worker `bidwizops` @ `clovrbid.com` | LIVE (version `c3184d3a-3612-4e4b-b79b-43aa47ebd2e1` deployed 2026-05-12) |
| **cron-trigger** | `apps/cron-trigger` (NEW) | Cloudflare Worker `bidwizops-cron` | LIVE (version `7f110cbf-b5b1-4db8-a505-270a8fd9e7d5`, cron triggers `* * * * *` and `*/5 * * * *` firing) |
| **field-mobile** | `apps/field-mobile` | TestFlight (preview + production channels) | Build 5 awaiting Apple processing / install |
| **bidder-app** | `apps/bidder-app` | TestFlight | Not updated this session (stale `EXPO_PUBLIC_API_BASE_URL`) |

---

## Cloudflare account ownership

- **Account belongs to Darren** (`shadetreerocketsurgeon84@gmail.com`) — Michael's CTO/IT guy
- **Michael has Superadmin** on Darren's account
- **API token for Claude-driven deploys** lives in `.env.cloudflare.local` at repo root (gitignored)
- The full ownership-migration plan to Michael's own Google is in `docs/CLOUDFLARE_OWNERSHIP_MIGRATION.md` — **not urgent**, Michael isn't blocked from operating

---

## State of production (2026-05-12 22:30 UTC)

| Surface | Status |
|---|---|
| operator-web | LIVE — new code includes `/api/cron/*` routes |
| bidwizops-cron | LIVE — firing every minute, hitting all 5 cron routes successfully |
| Supabase pg_cron | 4 jobs active: `finalize-due-lots` (5s), `drain-build-invoice-jobs` (30s), `mark-settlements-releasable` (1m), `cron-history-cleanup` (hourly). Verified hundreds of successful runs |
| Migrations | Through `0073_pg_cron_schedules.sql` applied |
| Stripe | Connect Standard via Accounts v2 controller properties. Workers-compat fetch HTTP client + async webhook signature verification |
| Notifications | Expo Push wired (2 real notifications sent end-to-end during verification). Resend + Twilio wired in code, will fire once `RESEND_API_KEY` + `TWILIO_*` secrets are set on `bidwizops` Worker |
| `packages/auction-engine/` | **DELETED** (it never deployed; ~1500 LOC removed) |

---

## What's still on your plate

### 1. Move `CRON_SECRET` to 1Password (Darren or Michael, 2 min)

File at `.cloudflare-migration/cron-secret.txt` (gitignored — won't get committed) holds the secret. Copy to 1Password as "ClovrBid Staff CRON_SECRET" and **delete the local file**.

### 2. Mobile (Michael, when Apple emails)

- Install TestFlight build 5 when Apple notifies
- Smoke-test: Quick Lot scan → AI returns candidate → photo upload. Confirm `ai_calls` table shows Cloudflare-hosted request (`clovrbid.com`)
- **Rotate `wwba-nsrm-iznu-kicu`** — Apple app-specific password that leaked through chat in a prior session. appleid.apple.com → Sign-In and Security → App-Specific Passwords → revoke + regen. Update `apps/field-mobile/.env` AND `apps/bidder-app/.env`
- **Flip bidder-app to Cloudflare URL**: `apps/bidder-app/.env` `EXPO_PUBLIC_API_BASE_URL` → `https://clovrbid.com`. Then build + submit a new bidder-app TestFlight

### 3. Optional cleanup, deferred

- **`/api/cron/cache-warm-drain`** — `product_cache_warm_jobs` table queues up from imports but nothing drains it yet. Needs OpenRouter LLM logic ported from the deleted `productCacheWarm.ts`. ~400 lines. Cache warming is discovery optimization, not critical path.
- **Major-version dep bumps** (do as a focused session, NOT via `npm update`):
  - Expo SDK 54 → 55 (couples RN 0.85, react-native-* set; forces a new TestFlight build)
  - React 19.1 → 19.2 (root override pins it; bump alongside Expo)
  - TypeScript 5.9 → 6.0
  - ESLint 9 → 10
  - Zod 3 → 4 (runtime-breaking, used everywhere)
- **Long-term: migrate CF account ownership** from Darren's Google → Michael's Google. Plan in `docs/CLOUDFLARE_OWNERSHIP_MIGRATION.md`. Not urgent.

---

## How to deploy from here

**For Cloudflare Worker code changes** — re-deploy with one command from WSL:

```bash
wsl -d Ubuntu
bash /mnt/c/Users/jmacl/Projects/auction-platform/scripts/deploy-cf.sh
# Optional: --rotate-cron-secret  (generates fresh shared secret)
#           --skip-build           (if .open-next/ already exists)
#           --skip-operator-web    (only deploy cron-trigger)
#           --skip-cron-trigger    (only deploy operator-web)
```

The script handles the rsync-to-WSL-native-FS workflow needed to avoid the `/mnt/c` EPERM error in Next.js builds (see `memory/feedback_wsl_native_builds.md`).

**For SQL migrations** — from PowerShell or WSL:

```bash
node scripts/apply-migrations.js
# or --status to dry-run
```

**To verify pg_cron health** anytime:

```bash
node scripts/verify-pg-cron.mjs
```

---

## Important docs added this session

- `docs/AUCTION_ENGINE_DEPLOY.md` — full deploy runbook for the new architecture (mostly executed already)
- `docs/CLOUDFLARE_OWNERSHIP_MIGRATION.md` — long-term plan for migrating CF account ownership (deferred, not urgent)
- `docs/ARCHITECTURE.md` — auction-engine section rewritten for pg_cron + cron Worker
- `scripts/deploy-cf.sh` — canonical Cloudflare deploy script
- `scripts/verify-pg-cron.mjs` — pg_cron health check

`docs/HANDOFF.md` is historical (May 6) — it describes the old plan, kept for context.

---

## How to resume next session

Open the new session with **"continue from docs/SESSION_HANDOFF.md"** or paste the link. The major remaining work is mobile (TestFlight install + password rotation + bidder-app URL flip), then the optional deferred items above.

Memory at `~/.claude/projects/C--Users-jmacl-Projects/memory/MEMORY.md` is up to date with the Darren/Michael relationship, the WSL-native-FS build constraint, and the new stack decisions (Supabase + Cloudflare, no BullMQ).
