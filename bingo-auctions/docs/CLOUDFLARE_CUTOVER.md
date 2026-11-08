# Cloudflare Pages cutover for operator-web

The codebase is **ready** to deploy to Cloudflare Pages as `bidwizops`.
The OpenNext bundle builds cleanly (verified). Everything that's left
needs a Cloudflare API token to authenticate.

## TL;DR — one command

If you've created an API token already and pulled Vercel env vars to
`.env.cloudflare-import.local` (already done — see Section 3), the
entire cutover is:

```powershell
# From Windows PowerShell:
wsl -d Ubuntu bash -c "cd /mnt/c/Users/jmacl/Projects/auction-platform && CLOUDFLARE_API_TOKEN=<your-token> bash scripts/cloudflare-cutover.sh"
```

That script: verifies the token, finds/creates the `bidwizops` Pages
project, pushes every env var, builds the OpenNext bundle, deploys,
prints the `*.pages.dev` URL. Idempotent — re-run any time to update
env vars or re-deploy. The rest of this doc walks through what it
does, and the bits it doesn't cover (custom domain + 3090 Tunnel).

Total wall-clock time with the script: **~10 minutes** end to end.

---

## 0. Before you start

You have **WSL Ubuntu** installed with Node 22 + wrangler 4. Every
Cloudflare-flavored command below runs **inside WSL** because workerd
(Cloudflare's Workers runtime, bundled with wrangler) has no
`win32-arm64` binary. Windows-native PowerShell calls to wrangler will
hang or fail.

To open WSL from any PowerShell:

```powershell
wsl -d Ubuntu
# you're now in bash. cd to the repo:
cd /mnt/c/Users/jmacl/Projects/auction-platform/apps/operator-web
```

Every command in this doc assumes you're in that WSL shell and that
working directory unless noted otherwise.

---

## 1. Authenticate wrangler (one-time, ~3 min)

```bash
npx wrangler login
```

This opens your default Windows browser. Click "Allow" in the Cloudflare
OAuth screen. The token gets stored in `~/.wrangler/config/default.toml`
inside the WSL Ubuntu home directory; subsequent commands just work.

Verify:

```bash
npx wrangler whoami
# should print your Cloudflare email + account ID
```

---

## 2. Create the Pages project (one-time, ~2 min)

If `bidwizops` doesn't already exist in your Cloudflare account, create
it via the dashboard once:

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages**
2. Select **Direct Upload** (NOT Connect to Git — we don't have a
   GitHub remote and we don't want one). Project name: **`bidwizops`**.
3. Click **Create project**. Skip the first manual upload prompt —
   our `wrangler pages deploy` from CLI will be the first upload.

If you already see `bidwizops` in the Workers & Pages list, skip this
section.

---

## 3. Set environment variables (one-time per env, ~10 min)

Cloudflare Pages uses **per-environment** env vars (Production /
Preview). Set the same vars in both unless noted.

Open: **Workers & Pages → bidwizops → Settings → Environment
variables**. Click **Add variable** for each. Values come from your
existing Vercel env (`vercel env pull .env.production.local` if you
want them as a file).

| Variable | Where it comes from | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel prod | Public, safe in client bundle |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel prod | Public |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel prod | **Secret** — mark as encrypted |
| `OPENROUTER_API_KEY` | Vercel prod | **Secret** |
| `ANTHROPIC_API_KEY` | Vercel prod | **Secret**; used as fallback by legacy paths |
| `REDIS_URL` | Vercel prod | **Secret**; for BullMQ producer |
| `ALLOW_SKIP_STRIPE_ONBOARDING` | Vercel prod | Public-ish flag |
| `TESTFLIGHT_FIELD_URL` | NEW — paste your TestFlight Public Link | Optional, used by /staff invite card |
| `TESTFLIGHT_BIDDER_URL` | NEW — paste your TestFlight Public Link | Optional |
| `LLM_OLLAMA_BASE_URL` | NEW — set after Tunnel section below | Optional, only when using local AI |
| `LLM_PROVIDER_<TASK>` | NEW — per task, set when ready | Optional |

**Tip:** Use `npx wrangler pages secret put VAR_NAME --project-name
bidwizops` from WSL to set secrets in bulk via CLI instead of clicking
through the dashboard. Cleaner for the long list of Supabase / API keys.

---

## 4. First deploy (~10 min)

From WSL Ubuntu inside `apps/operator-web`:

```bash
npm run cf:build
# runs `next build` then `opennextjs-cloudflare build`
# produces .open-next/worker.js + .open-next/assets/
# ~2-3 min cold, ~1 min warm
```

Then deploy:

```bash
npm run cf:deploy
# wrapper for: wrangler pages deploy .open-next/assets --project-name bidwizops
# prompts for the production branch confirmation on first run
# returns the deploy URL (something like https://abc123.bidwizops.pages.dev)
```

Open that URL in a browser. The login page should render. Try signing
in. If something looks wrong, check the **Functions logs** under
Workers & Pages → bidwizops → Logs.

Common first-deploy issues:

- **500 on every route** → env vars not set. Add them in dashboard, redeploy.
- **"Could not find a relationship" PostgREST errors** → Supabase
  schema cache stale. Re-deploy or wait 60s.
- **Image optimization errors** → check that `next.config.ts`
  `remotePatterns` includes your hosts (already does for Supabase).
- **Auth cookie not setting** → check that `NEXT_PUBLIC_SUPABASE_URL`
  is the production URL, not localhost.

---

## 5. Custom domain (~5 min + DNS propagation time)

In the Pages dashboard:

1. **bidwizops → Custom domains** → **Set up a custom domain**
2. Enter the domain — for example `app.cluerholdings.com` or `bidwizops.com`
3. Cloudflare auto-creates the CNAME if the domain is already managed in your Cloudflare DNS. Otherwise it gives you the records to add at your registrar.
4. Wait for the green check. SSL provisions automatically.

Test sign-in flow on the real domain. Update Supabase auth's Site URL
to match:

```bash
# from the repo root, NOT WSL — uses Node which is fine on Windows ARM
cd /mnt/c/Users/jmacl/Projects/auction-platform
# Update Supabase site URL via Management API. Replace the URL below.
TOKEN=$(grep "^SUPABASE_ACCESS_TOKEN=" .env.migrations.local | cut -d= -f2-)
REF=$(grep "^SUPABASE_PROJECT_REF=" .env.migrations.local | cut -d= -f2-)
curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -d '{
    "site_url": "https://app.cluerholdings.com",
    "uri_allow_list": "https://app.cluerholdings.com,https://app.cluerholdings.com/**,https://app.cluerholdings.com/auth/callback,bidwizops://*,bidwizops://,auctionplatform://*,auctionplatform://"
  }'
```

(Leave Vercel alive in the meantime. Once Cloudflare is verified, you
can pause/delete the Vercel project — or keep it as instant rollback.)

---

## 6. Cloudflare Tunnel for the 3090 Ollama server (~15 min)

Now that the web app is on Cloudflare, exposing your local AI server
through the same account is straightforward.

On the **3090 host** (the Windows machine running Ollama at `10.10.10.210:11434`):

```powershell
# 1. Install cloudflared
winget install --id Cloudflare.cloudflared

# 2. Authenticate (browser flow, picks the domain we'll use)
cloudflared tunnel login

# 3. Create the tunnel
cloudflared tunnel create bidwizops-ollama
# prints a tunnel UUID — note it

# 4. Create DNS record pointing at the tunnel
cloudflared tunnel route dns bidwizops-ollama ollama.cluerholdings.com
# replace cluerholdings.com with whatever domain you own in Cloudflare

# 5. Create the tunnel config
notepad C:\Users\jmacl\.cloudflared\config.yml
```

Paste in:

```yaml
tunnel: <TUNNEL_UUID_FROM_STEP_3>
credentials-file: C:\Users\jmacl\.cloudflared\<TUNNEL_UUID>.json

ingress:
  - hostname: ollama.cluerholdings.com
    service: http://localhost:11434
  - service: http_status:404
```

Run as a Windows service so it survives reboots:

```powershell
cloudflared service install
```

Once running, test from anywhere:

```bash
curl https://ollama.cluerholdings.com/api/tags
# should return the list of installed Ollama models (nemotron3:33b, etc.)
```

Then in Cloudflare Pages bidwizops env vars:

```
LLM_OLLAMA_BASE_URL=https://ollama.cluerholdings.com/v1
LLM_PROVIDER_DESCRIPTION_GENERATE=ollama  # start with one safe task
```

Redeploy with `npm run cf:deploy`. Check `ai_calls` table for
`ollama/...` rows landing.

---

## 7. Rollback

If something goes seriously wrong on Cloudflare and you need to revert:

1. **Don't kill the Vercel project** until you've been on Cloudflare a
   week without surprises. Vercel costs $0/mo on Hobby.
2. Update DNS: point your domain CNAME back at `cname.vercel-dns.com`.
   Propagates in ~5 min if TTL is low.
3. Update Supabase Site URL back to the Vercel domain (same Management
   API curl as in Section 5, just swap the URL).
4. File a bug, fix it, deploy to Cloudflare again, re-cut DNS.

---

## Where the build outputs live

- `apps/operator-web/.next/` — Next.js build output (gitignored)
- `apps/operator-web/.open-next/` — Cloudflare Worker bundle (gitignored)
- `apps/operator-web/wrangler.jsonc` — committed config
- `apps/operator-web/open-next.config.ts` — committed config
- `apps/operator-web/package.json` — `cf:build`, `cf:preview`, `cf:deploy` scripts

## Where the WSL toolchain lives

- Ubuntu distro: `wsl -d Ubuntu`
- Node 22 + npm at `/usr/bin/node` inside WSL
- Wrangler at `apps/operator-web/node_modules/.bin/wrangler` (call via `npx`)
- Wrangler config: `~/.wrangler/` inside WSL (gitignored by definition)

## Why we can't `cf:build` from Windows PowerShell

The `workerd` package (Cloudflare's Workers runtime, used by
`wrangler dev` and `opennextjs-cloudflare build`) has prebuilt binaries
for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and
`win32-x64` — but NOT `win32-arm64`. Your machine is Windows ARM. WSL
emulates Linux on top, where workerd's `linux-arm64` binary works fine.

When Cloudflare publishes a `win32-arm64` workerd, this whole WSL
indirection goes away.
