#!/usr/bin/env node
// Post-deploy check — run after every deploy (website, migration, OTA).
// Confirms the fixes shipped the week of 2026-09-28 still work on prod.
// Read-only: it only reads the site, the public API and the database. The one
// side effect is a staff demo sign-in (a normal auth login, signed out at the
// end) so the FedEx block can be exercised through the real route.
//
// Run: gh workflow run post-deploy-check.yml && gh run watch   (about a minute)
// Exit 1 if any check FAILS. A failed check means: roll back first,
// investigate second.
//
// Env (set by .github/workflows/post-deploy-check.yml):
//   SUPABASE_ACCESS_TOKEN  Management API token (read-only SQL via /database/query)
//   SUPABASE_URL, SUPABASE_ANON_KEY   the app's public URL and key
//   STAFF_EMAIL, STAFF_PASSWORD       staff demo account (FedEx block check)
//   SITE (optional)                   default https://bingoauctions.com

const SITE = process.env.SITE || 'https://bingoauctions.com';
const PROJECT_REF = 'npwseclcxcatjhgjrtwe';
const { SUPABASE_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY, STAFF_EMAIL, STAFF_PASSWORD } = process.env;

// Two real FedEx labels from BinGo manifests that fail the UPC check digit, so
// the route refuses them for any caller (catalog-refusal 'non_gtin_numeric').
// About 9 in 10 real labels are like this. The staff demo account belongs to
// the demo operator, so the manifest-tracking refusal can't be exercised here.
const FEDEX_TRACKING = ['541254268295', '541253983953'];

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`sql ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function check(name, fn) {
  try {
    const out = await fn();
    record(name, out.ok, out.detail);
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

await check('site up', async () => {
  const res = await fetch(`${SITE}/`, { redirect: 'follow' });
  return { ok: res.status === 200, detail: `GET / → ${res.status}` };
});

await check('search finds "TV" (website)', async () => {
  const res = await fetch(`${SITE}/browse?q=tv`);
  const html = await res.text();
  const lots = new Set(html.match(/\/lot\/BIN-\d+/g) ?? []);
  return { ok: res.status === 200 && lots.size > 0, detail: `GET /browse?q=tv → ${res.status}, ${lots.size} lots` };
});

await check('Recent Wins loads (app RPC as the public key)', async () => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_recent_wins`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_days: 7, p_limit: 10 }),
  });
  const body = await res.json();
  const n = Array.isArray(body) ? body.length : 0;
  return { ok: res.status === 200 && n > 0, detail: res.status === 200 ? `${n} wins` : `${res.status} ${JSON.stringify(body).slice(0, 160)}` };
});

await check('paid invoices have a pickup record (last 48 h)', async () => {
  const [r] = await sql(`
    SELECT count(*) AS paid,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM pickups p WHERE p.invoice_id = i.id)) AS missing
    FROM invoices i
    WHERE i.status = 'paid' AND i.paid_at > now() - interval '48 hours'
      AND coalesce(i.fulfillment_method, 'pickup') <> 'ship'`);
  return { ok: Number(r.missing) === 0, detail: `${r.paid} paid, ${r.missing} without a pickup record` };
});

await check('FedEx block: tracking number gets no match', async () => {
  const signIn = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD }),
  });
  if (!signIn.ok) return { ok: false, detail: `staff demo sign-in failed: ${signIn.status}` };
  const { access_token: token } = await signIn.json();
  try {
    const outcomes = [];
    for (const code of FEDEX_TRACKING) {
      const res = await fetch(`${SITE}/api/lottr/lookup-code`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ code, fast: true }),
      });
      const body = await res.json().catch(() => ({}));
      outcomes.push({ code, status: res.status, error: body.error, cacheMiss: body.cacheMiss });
    }
    const ok = outcomes.every((o) => o.status === 404 && o.error === 'no_match' && !o.cacheMiss);
    return { ok, detail: outcomes.map((o) => `${o.code}→${o.status} ${o.error ?? ''}`).join(', ') };
  } finally {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
});

await check('FedEx block: no invented catalog rows came back', async () => {
  const [r] = await sql(`
    SELECT count(*) AS n FROM product_lookups
    WHERE upc IN (SELECT upc FROM _poisoned_tracking_lookups_20260924)`);
  return { ok: Number(r.n) === 0, detail: `${r.n} of 0372's 16 rows present` };
});

await check('crash route up and storing (read-only)', async () => {
  const res = await fetch(`${SITE}/api/telemetry/crash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'post-deploy-check' }), // invalid on purpose: 400, nothing stored
  });
  const [r] = await sql(`
    SELECT (SELECT count(*) FROM client_crash_reports WHERE created_at > now() - interval '24 hours') AS last_24h,
           (SELECT count(*) FROM (SELECT report_id FROM client_crash_reports WHERE report_id IS NOT NULL
                                  GROUP BY report_id HAVING count(*) > 1) d) AS dup_ids`);
  const ok = res.status === 400 && Number(r.dup_ids) === 0;
  return { ok, detail: `bad body → ${res.status}; ${r.last_24h} reports stored in 24 h; ${r.dup_ids} duplicate report ids` };
});

await check('test auctions stay hidden', async () => {
  const [r] = await sql(`
    SELECT
      (SELECT count(*) FROM lots l JOIN auctions a ON a.id = l.auction_id
        WHERE l.status = 'live' AND l.close_at > now() AND a.unlisted) AS live_unlisted,
      (SELECT count(*) FROM lots l JOIN auctions a ON a.id = l.auction_id JOIN operators o ON o.id = a.operator_id
        WHERE l.status = 'live' AND l.close_at > now() AND a.status IN ('scheduled', 'live')
          AND NOT a.unlisted AND o.is_demo IS NOT TRUE) AS live_listed,
      (SELECT coalesce(jsonb_agg(l.lot_code), '[]'::jsonb) FROM lots l JOIN auctions a ON a.id = l.auction_id
        WHERE l.status = 'live' AND l.close_at > now() AND a.unlisted) AS unlisted_codes,
      (SELECT count(*) FROM get_recent_wins(7, 50) w JOIN invoices i ON i.id = w.invoice_id
        JOIN auctions a ON a.id = i.auction_id JOIN operators o ON o.id = a.operator_id
        WHERE a.unlisted OR o.is_demo) AS wins_from_test`);
  const stats = await (await fetch(`${SITE}/api/public/stats?check=${Date.now()}`)).json();
  const browse = await (await fetch(`${SITE}/browse`)).text();
  const leaked = (r.unlisted_codes ?? []).filter((c) => browse.includes(`/lot/${c}`));
  // The counter is cached for 30 s, so allow lots closing in that window.
  const statsOk = Math.abs(stats.live_lots_count - Number(r.live_listed)) <= 10;
  const ok = statsOk && leaked.length === 0 && Number(r.wins_from_test) === 0;
  return {
    ok,
    detail:
      `${r.live_unlisted} live test-auction lots now; counter ${stats.live_lots_count} vs listed ${r.live_listed}; ` +
      `${leaked.length} on /browse; ${r.wins_from_test} in Recent Wins`,
  };
});

// ── Report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  —  ${r.detail}`);
console.log(lines.join('\n'));
console.log(failed.length ? `\n${failed.length} FAILED — roll back first, investigate second.` : '\nAll checks passed.');
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Post-deploy check\n\n| | Check | Detail |\n|---|---|---|\n` +
      results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.detail} |`).join('\n') +
      (failed.length ? `\n\n**${failed.length} failed — roll back first, investigate second.**\n` : '\n\nAll checks passed.\n'),
  );
}
process.exit(failed.length ? 1 : 0);
