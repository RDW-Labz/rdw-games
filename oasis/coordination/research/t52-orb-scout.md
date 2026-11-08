# T52 scout: orb as the swarm's UI verifier

**GO** — orb can drive the desktop-app frontend in plain Chromium against the existing fake
backend today; the loopback sandbox question needs a decision (no single-port allowlist exists).

## Q1 — Plain Chromium + mock backend?

Yes, and a full mock/fixture path already exists, no need to build one.

- Backend reach: HTTP `fetch` + `WebSocket` to a `baseUrl`, obtained via Tauri
  `invoke('resolve_service_base_url')` (`src/lib/platform.ts`). Auth token via
  `invoke('get_service_token')`. Outside a Tauri runtime the invoke import rejects;
  `App.tsx`/`QuickApp.tsx`/`OrbApp.tsx` all catch that and fall back to a hardcoded
  `http://127.0.0.1:4405` (matches `RIG_SERVICE_DEFAULT_PORT` in `ref/claude-shell.mjs`).
- Existing fixture: `desktop-app/vite.config.ts`'s `preview-browser` mode aliases
  `@tauri-apps/api/{core,event,window,menu}` to `tests/preview/*Stub.ts`.
  `tauriStub.ts`'s `invoke()` answers `resolve_service_base_url` with
  `VITE_PREVIEW_SERVICE_URL` and `get_service_token`/`forget_service_token` with
  `sk-FAKE-0000`. `tests/fakeService.ts` is a full fake HTTP/WS backend (`/status`,
  `/onboarding/*`, `/theme`, `/avatar`, `/connectors`, WS `/chat`, etc.), already used
  by `npm run dev:fake-service` and `scripts/preview-screens.ts`.
- If no fixture existed, a mock would need to answer (observed on Home, ≤10):
  `GET /status`, `GET /onboarding/questions`, `GET /theme`, `GET /avatar`,
  `GET /connectors`, `WS /chat` (open only), plus Tauri `resolve_service_base_url`
  and `get_service_token` (or rely on the hardcoded `:4405` fallback and skip those two).

## Q2 — Sandbox loopback restricted to 127.0.0.1:4318 only? (report only)

No, not with today's mechanism. `shellProfile()` in `ref/claude-shell.mjs`: when
`loopbackDenied` is passed, it emits a broad
`(allow network-bind network-inbound (local ip "localhost:*"))` /
`(allow network-outbound (remote ip "localhost:*"))`, then appends per-port
**deny** rules only for ports that were already listening on the host at job start
(`scanListeningPorts`, via `lsof`), excluding `proxyPort`. This is a blocklist of
pre-existing listeners, not an allowlist of one port — there is no rule shape here
that grants only 4318 and refuses every other loopback port. Separately,
`validateNetworkAllow()` refuses any non-empty `networkAllow` list outright
("not yet supported"); the only outbound allow beyond loopback is the fixed
`api.anthropic.com:443` CONNECT proxy.

Empirically, my own sandbox:
- `net.createServer().listen(4318, '127.0.0.1')` + `net.connect(4318, ...)`: **ok/ok**.
- Same test on port 4319 (arbitrary other port): **ok/ok**.
- `net.connect(80, '93.184.216.34')` (external IP): **EPERM**.

So this job's sandbox is loopback-open (minus whatever was already listening) or
closed to the outside world — never narrowed to a single port.

## Q3 — Home scenario with orb

**Pass.** Opened the main window (`index.html`, "Home") through the existing fixture
(`tests/fakeService.ts` + `preview-browser` Tauri stubs + Vite middleware-mode server),
set `service.setOrbState('proposal_ready')` (→ `lampLook` `'ready'`), and asserted
`[data-look="ready"]` and the exact text "Something needs you" both rendered.
Screenshot saved to `out/home.png` (1280×800, shows the amber lamp dot and the
"Something needs you" line above Settings). Zero unexpected console errors.

## Commands (see `t52-result.json.commands` for the capped list; last lines below)

- `node -e` loopback listen+connect probe on 4318 → `{"port":4318,"listen":"ok","connect":"ok"}`
- `node -e` loopback listen+connect probe on 4319 → `{"port":4319,"listen":"ok","connect":"ok"}`
- `node -e` connect to external IP:80 → `error: EPERM`
- `node --import tsx/esm home-scenario.mts` (Home scenario) → `LAMP_OK true` / `TEXT_OK true` / `PASS true`

## Blockers hit and worked around (scratch only, no repo edits)

1. `tsx` CLI's IPC unix-socket path under the job's scratch `TMPDIR` exceeded macOS's
   ~104-char `sun_path` limit (`EINVAL`) → ran `node --import tsx/esm` instead of the
   `tsx` binary.
2. Vite's `loadConfigFromFile` tried to write a bundled temp file into
   `desktop-app/node_modules/.vite-temp` (read-only tree, `EPERM`) → passed
   `configFile: false` to `createServer()` and replicated `vite.config.ts`'s
   `preview-browser` branch (same alias map, same react plugin options) inline from
   my scratch script instead of loading the file. `cacheDir` was pointed at a
   directory under my scratch `TMPDIR`, per the task's own guidance.
3. `desktop-app`'s pinned Playwright (1.58.2) wants `chromium_headless_shell-1208`,
   not installed; only `chromium-1243` is (matching orb's Playwright 1.63.0) →
   launched Chromium through `orb/node_modules/playwright` instead.
4. CORS blocked the Vite-origin page from fetching the fake-service origin until a
   `browserOrigin` callback was supplied to `createFakeService` (mirroring
   `scripts/preview-screens.ts`'s own pattern).

None of these needed a repo edit; `orb/`, `desktop-app/`, `ref/` were never modified
(verified: `git status` shows no changes to those trees).

## What a later wiring ticket would need

Point orb's `orb_attach` at the Vite dev server origin while `dev:fake-service` (or an
equivalent scratch-launched fake) runs on loopback, and decide whether shell jobs get a
narrower loopback allow (a real 4318-only rule) or keep today's "everything but
pre-existing listeners" shape.
