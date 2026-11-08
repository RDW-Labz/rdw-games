#!/usr/bin/env node
// prod-http-smoke.mjs
// ----------------------------------------------------------------------------
// Post-deploy reachability smoke. Hits the deployed public routes and asserts
// each returns a healthy status. Run AFTER a Cloudflare deploy (or any time)
// to confirm the Worker boots + SSR renders:
//
//   node scripts/smoke/prod-http-smoke.mjs                 # https://clovrbid.com
//   node scripts/smoke/prod-http-smoke.mjs https://staging.example.com
//
// NOT wired into PR CI on purpose — it needs the live deployment + network, so
// it would flake as a merge gate. It's an operator tool / optional post-deploy
// step. Exits non-zero if any route is unhealthy.
// ----------------------------------------------------------------------------

const BASE = (process.argv[2] ?? 'https://clovrbid.com').replace(/\/$/, '');

// Public, unauthenticated routes. The operator console root should redirect to
// /login when unauthenticated (3xx), never 500.
const ROUTES = [
  { path: '/', okStatuses: [200] },
  { path: '/browse', okStatuses: [200] },
  { path: '/login', okStatuses: [200] },
  { path: '/dashboard', okStatuses: [200, 302, 307, 308] },
];

const TIMEOUT_MS = 20_000;

async function check({ path, okStatuses }) {
  const url = `${BASE}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // redirect: 'manual' so a redirect to /login is observed as 3xx, not
    // followed to a 200 — we want to know the route itself was served.
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    return { path, url, status: res.status, ok: okStatuses.includes(res.status) };
  } catch (err) {
    return { path, url, status: 0, ok: false, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const results = await Promise.all(ROUTES.map(check));
let failed = 0;
for (const r of results) {
  console.log(`  [${r.ok ? 'OK ' : 'FAIL'}] ${r.status || '---'}  ${r.url}${r.error ? `  (${r.error})` : ''}`);
  if (!r.ok) failed++;
}

if (failed > 0) {
  console.error(`\nprod-http-smoke: ${failed}/${results.length} route(s) unhealthy against ${BASE}`);
  process.exit(1);
}
console.log(`\nprod-http-smoke: OK (${results.length} routes healthy on ${BASE})`);
