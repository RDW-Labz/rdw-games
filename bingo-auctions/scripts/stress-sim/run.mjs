// stress-sim/run.mjs — 500 bidders × 500 lots "daily close" stress simulation.
//
// Drives the REAL database engine (place_bid, open_due_lots, finalize_due_lots,
// drain_build_invoice_jobs, advance_auction_lifecycle — the exact functions
// pg_cron runs in prod) against a fully-migrated local Postgres, at a time
// compression of ~10×: a real BinGo day staggers 500 lots over a ~2 h close
// window (14.4 s/lot); the sim staggers them 1.5 s apart (~12.5 min), so every
// rate the engine sees is ~10× the real daily rate. Surviving this cleanly
// demonstrates ≥10× headroom on the real day.
//
// Bidder impersonation: the shim's auth.uid() reads the app.sim_uid GUC, so
// each place_bid call goes through the full production gate stack (payment
// method, unpaid fees, suspension, increments, proxy duel, soft close).
//
// Usage: node run.mjs   (assumes stress_sim DB migrated via shim.sql + migrations)

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { Pool, Client } = pg;

// ── Config ────────────────────────────────────────────────────────────────────
const CFG = {
  BIDDERS: 500,
  LOTS: 500,
  STAGGER_MS: 1_500,          // real day: 14_400 ms (2 h / 499) → 9.6× compression
  FIRST_CLOSE_IN_MS: 75_000,  // lead time before lot #1 closes (bidding ramp)
  SOFT_CLOSE_MINUTES: 1,      // real day: 2 min → soft close is compressed only 2×,
                              // i.e. RELATIVELY more aggressive than prod = conservative
  PREBIDS_PER_LOT_AVG: 8,     // "during the day" bids per lot (mean, geometric-ish)
  STORM_FRACTION: 0.30,       // lots that get a live snipe duel in the final window
  BID_CONNS: 24,              // concurrent bidder connections (Supabase pooler scale)
  BUYER_PREMIUM_BPS: 1500,    // BinGo: 15%
  TAX_RATE_BPS: 950,          // Harrison AR 9.5% (mig 0214)
  CHARGE_SUCCESS_RATE: 0.9,   // mock auto-charge worker outcome mix
};

const DSN = { host: 'localhost', user: 'postgres', password: 'postgres', database: 'stress_sim' };

const engine = new Client(DSN);      // cron emulation (sequential ticks)
const admin = new Client(DSN);       // setup + verification
const bidPool = new Pool({ ...DSN, max: CFG.BID_CONNS });

// ── Metrics ───────────────────────────────────────────────────────────────────
const M = {
  bidLatencies: [],            // ms per place_bid call (accepted or rejected)
  bidResults: {},              // reason -> count
  extensions: 0,
  ticks: [],                   // {fn, ms, at, result}
  backlog: [],                 // {at, liveDue} sampled before each finalize tick
  errors: [],
};
const t0 = Date.now();
const rel = (ts) => ((ts - t0) / 1000).toFixed(1);

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Setup ─────────────────────────────────────────────────────────────────────
const ids = {
  operator: randomUUID(),
  warehouse: randomUUID(),
  auction: randomUUID(),
  bidders: Array.from({ length: CFG.BIDDERS }, () => randomUUID()),
  lots: Array.from({ length: CFG.LOTS }, () => randomUUID()),
};

async function setup() {
  await admin.query('BEGIN');
  await admin.query(
    `INSERT INTO operators (id, slug, code, business_name, contact_email, status,
       stripe_onboarding_complete, stripe_charges_enabled, collect_sales_tax, tax_rate_bps)
     VALUES ($1, 'sim-bingo', 'SIM', 'SIM BinGo Auctions', 'sim@stress.sim.test', 'active',
       true, true, true, $2)`,
    [ids.operator, CFG.TAX_RATE_BPS],
  );
  await admin.query(
    `INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code,
       floor_plan_width_px, floor_plan_height_px)
     VALUES ($1, $2, 'SIM Warehouse', '1 Sim St', 'Harrison', 'AR', '72601', 2000, 1500)`,
    [ids.warehouse, ids.operator],
  );

  const firstClose = new Date(t0 + CFG.FIRST_CLOSE_IN_MS);
  const lastClose = new Date(t0 + CFG.FIRST_CLOSE_IN_MS + (CFG.LOTS - 1) * CFG.STAGGER_MS);
  await admin.query(
    `INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at,
       last_lot_ends_at, pickup_starts_at, pickup_ends_at, soft_close_minutes, buyer_premium_bps)
     VALUES ($1, $2, $3, 'SIM Daily Auction', 'live', now(), $4, $5,
       $4::timestamptz + interval '1 day', $4::timestamptz + interval '4 days', $6, $7)`,
    [ids.auction, ids.operator, ids.warehouse,
     firstClose.toISOString(), lastClose.toISOString(), CFG.SOFT_CLOSE_MINUTES, CFG.BUYER_PREMIUM_BPS],
  );

  // 500 bidders: auth stub row + bidders row with a card on file so the real
  // payment gates pass (payments stay ENABLED, matching prod).
  await admin.query(
    `INSERT INTO auth.users (id, email)
     SELECT u, 'sim-' || ordinality || '@stress.sim.test'
     FROM unnest($1::uuid[]) WITH ORDINALITY AS t(u, ordinality)`, [ids.bidders]);
  await admin.query(
    `INSERT INTO bidders (id, email, display_name, default_payment_method_id, card_brand, card_last4, birth_date)
     SELECT u, 'sim-' || ordinality || '@stress.sim.test', 'Sim Bidder ' || ordinality,
            'sim-card-' || ordinality, 'VISA', lpad((ordinality % 10000)::text, 4, '0'),
            date '1970-01-01' + (ordinality % 10000)::int
     FROM unnest($1::uuid[]) WITH ORDINALITY AS t(u, ordinality)`,
    [ids.bidders]);

  // 500 lots, then stagger close_at exactly like redistribute_close_times():
  // close_at = ends_at + (lot_number-1) * step.
  await admin.query(
    `INSERT INTO lots (id, operator_id, auction_id, warehouse_id, lot_number, lot_code, title, condition,
       starting_bid_cents, status, close_at)
     SELECT u, $2, $3, $4, ordinality, 'SIM-' || lpad(ordinality::text, 6, '0'),
       'Sim Lot ' || ordinality, 'good', 100, 'scheduled', $5
     FROM unnest($1::uuid[]) WITH ORDINALITY AS t(u, ordinality)`,
    [ids.lots, ids.operator, ids.auction, ids.warehouse, firstClose.toISOString()]);
  await admin.query(
    `UPDATE lots SET close_at = $2::timestamptz + (lot_number - 1) * ($3 || ' milliseconds')::interval
     WHERE auction_id = $1`,
    [ids.auction, firstClose.toISOString(), CFG.STAGGER_MS]);

  // Match BinGo prod platform flags: payments ON, KYC gate OFF (mig 0212).
  await admin.query(`UPDATE platform_settings SET identity_verification_disabled = true WHERE id = true`);
  await admin.query('COMMIT');

  const { rows } = await admin.query(
    `SELECT min(close_at) AS first, max(close_at) AS last FROM lots WHERE auction_id=$1`, [ids.auction]);
  console.log(`[setup] operator+auction+${CFG.LOTS} lots+${CFG.BIDDERS} bidders ready`);
  console.log(`[setup] closes ${rows[0].first.toISOString()} → ${rows[0].last.toISOString()}`);
}

// ── Engine (cron emulation) ───────────────────────────────────────────────────
let engineStop = false;
async function tick(fn, sql) {
  const s = process.hrtime.bigint();
  try {
    const r = await engine.query(sql);
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    M.ticks.push({ fn, ms, at: Date.now(), result: r.rows[0] ?? null });
  } catch (e) {
    M.errors.push(`[engine ${fn}] ${e.message}`);
  }
}

async function engineLoop() {
  let n = 0;
  while (!engineStop) {
    // backlog sample: live lots already past close (finalize debt)
    try {
      const { rows } = await engine.query(
        `SELECT count(*)::int AS due FROM lots WHERE status='live' AND close_at <= now()`);
      M.backlog.push({ at: Date.now(), due: rows[0].due });
    } catch (e) { M.errors.push(`[backlog] ${e.message}`); }

    await tick('open_due_lots', 'SELECT public.open_due_lots()');
    await tick('finalize_due_lots', 'SELECT public.finalize_due_lots() AS r');
    if (n % 6 === 0) await tick('drain_build_invoice_jobs', 'SELECT public.drain_build_invoice_jobs() AS r');
    if (n % 12 === 0) await tick('advance_auction_lifecycle', 'SELECT public.advance_auction_lifecycle() AS r');
    n++;
    await sleep(5_000);
  }
}

// ── Bidders ───────────────────────────────────────────────────────────────────
async function placeBid(bidderIdx, lotIdx, maxCents) {
  const c = await bidPool.connect();
  const s = process.hrtime.bigint();
  try {
    await c.query(`SELECT set_config('app.sim_uid', $1, false)`, [ids.bidders[bidderIdx]]);
    const { rows } = await c.query(
      `SELECT * FROM public.place_bid($1::uuid, $2::bigint)`, [ids.lots[lotIdx], maxCents]);
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    M.bidLatencies.push(ms);
    const r = rows[0];
    M.bidResults[r.reason] = (M.bidResults[r.reason] ?? 0) + 1;
    if (r.was_extended) M.extensions++;
    return r;
  } catch (e) {
    M.bidLatencies.push(Number(process.hrtime.bigint() - s) / 1e6);
    M.bidResults[`exception:${e.message.slice(0, 40)}`] =
      (M.bidResults[`exception:${e.message.slice(0, 40)}`] ?? 0) + 1;
    return null;
  } finally {
    c.release();
  }
}

// Lot "value" anchors bid budgets: $20–$800 MSRP-ish, bidders pay 5–60% of it.
const lotValueCents = Array.from({ length: CFG.LOTS }, () => randInt(2_000, 80_000));

// Pre-close "daytime" bids: scheduled uniformly from now until shortly before
// the lot's nominal close. Each is a proxy max from a random bidder.
function scheduleDayBids() {
  const events = [];
  for (let lot = 0; lot < CFG.LOTS; lot++) {
    const nominalClose = CFG.FIRST_CLOSE_IN_MS + lot * CFG.STAGGER_MS;
    const n = Math.max(1, Math.round(-CFG.PREBIDS_PER_LOT_AVG * Math.log(1 - Math.random()))); // exp dist
    for (let i = 0; i < Math.min(n, 30); i++) {
      const at = rand(2_000, Math.max(4_000, nominalClose - 8_000));
      const maxCents = Math.round(lotValueCents[lot] * rand(0.05, 0.6));
      events.push({ at, lot, bidder: randInt(0, CFG.BIDDERS - 1), maxCents });
    }
  }
  events.sort((a, b) => a.at - b.at);
  return events;
}

// Snipe duel: two bidders alternate topping each other inside the soft-close
// window, each raise re-extending close_at — exactly the anti-snipe cascade a
// real daily close produces. Runs live (reacts to extensions) until one budget
// is exhausted or the lot closes.
async function snipeDuel(lot) {
  const a = randInt(0, CFG.BIDDERS - 1);
  let b = randInt(0, CFG.BIDDERS - 1);
  if (b === a) b = (b + 1) % CFG.BIDDERS;
  const budgets = [
    Math.round(lotValueCents[lot] * rand(0.4, 0.9)),
    Math.round(lotValueCents[lot] * rand(0.4, 0.9)),
  ];
  const duelists = [a, b];
  let turn = 0;
  let cur = 0;
  for (let round = 0; round < 24; round++) {
    const who = duelists[turn % 2];
    const budget = budgets[turn % 2];
    const ask = Math.max(cur + randInt(25, 200), Math.round(cur * 1.1));
    if (ask > budget) break;
    const r = await placeBid(who, lot, ask);
    if (!r) break;
    if (r.reason === 'lot_closed' || r.reason === 'lot_not_biddable') break;
    if (r.current_bid_cents != null) cur = Number(r.current_bid_cents);
    turn++;
    await sleep(rand(400, 1_800));
  }
}

async function bidLoad() {
  const day = scheduleDayBids();
  console.log(`[bids] ${day.length} daytime proxy bids scheduled`);
  const inflight = new Set();

  // Storm lots: fire a duel starting ~45 s before each storm lot's nominal close.
  const stormLots = [];
  for (let lot = 0; lot < CFG.LOTS; lot++) {
    if (Math.random() < CFG.STORM_FRACTION) {
      stormLots.push({ lot, at: CFG.FIRST_CLOSE_IN_MS + lot * CFG.STAGGER_MS - rand(20_000, 45_000) });
    }
  }
  console.log(`[bids] ${stormLots.length} snipe duels scheduled`);
  stormLots.sort((x, y) => x.at - y.at);

  let di = 0, si = 0;
  while (di < day.length || si < stormLots.length) {
    const now = Date.now() - t0;
    while (di < day.length && day[di].at <= now) {
      const e = day[di++];
      const p = placeBid(e.bidder, e.lot, e.maxCents).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    while (si < stormLots.length && stormLots[si].at <= now) {
      const s = stormLots[si++];
      const p = snipeDuel(s.lot).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    await sleep(50);
  }
  await Promise.allSettled([...inflight]);
  console.log(`[bids] all bid load dispatched (${rel(Date.now())}s)`);
}

// ── Drain / verify / report ───────────────────────────────────────────────────
async function waitForQuiescence() {
  // Wait until no live/scheduled lots remain, then let the invoice debounce
  // (30 s) + drain tick clear the job queue.
  for (;;) {
    const { rows } = await admin.query(
      `SELECT count(*) FILTER (WHERE status IN ('live','scheduled'))::int AS open FROM lots WHERE auction_id=$1`,
      [ids.auction]);
    if (rows[0].open === 0) break;
    await sleep(5_000);
  }
  console.log(`[drain] all lots closed at ${rel(Date.now())}s — waiting for invoice jobs`);
  for (let i = 0; i < 24; i++) {
    const { rows } = await admin.query(`SELECT count(*)::int AS jobs FROM build_invoice_jobs`);
    if (rows[0].jobs === 0) break;
    await sleep(5_000);
  }
}

async function mockChargeWorker() {
  // Prod: the cron Worker drains auto_charge_jobs via Square. Simulate its
  // outcome mix so downstream states (paid / payment_failed_grace) populate.
  const { rows } = await admin.query(`SELECT invoice_id FROM auto_charge_jobs`);
  let paid = 0, failed = 0;
  for (const r of rows) {
    if (Math.random() < CFG.CHARGE_SUCCESS_RATE) {
      await admin.query(
        `UPDATE invoices SET status='paid', paid_at=now(), square_payment_id='sim-pay-'||substr(id::text,1,8) WHERE id=$1`,
        [r.invoice_id]);
      paid++;
    } else {
      await admin.query(
        `UPDATE invoices SET status='payment_failed_grace', grace_until=now()+interval '48 hours',
           last_auto_charge_at=now(), last_auto_charge_error='sim: card_declined' WHERE id=$1`,
        [r.invoice_id]);
      failed++;
    }
    await admin.query(`DELETE FROM auto_charge_jobs WHERE invoice_id=$1`, [r.invoice_id]);
  }
  return { paid, failed };
}

async function verifyAndReport(chargeMix) {
  const q = async (sql, params = []) => (await admin.query(sql, params)).rows;

  const [lotStats] = await q(`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status='won')::int AS won,
      count(*) FILTER (WHERE status='unsold')::int AS unsold,
      count(*) FILTER (WHERE status NOT IN ('won','unsold'))::int AS other
    FROM lots WHERE auction_id=$1`, [ids.auction]);

  // Winner correctness: winner must hold the highest max (ties → earliest).
  const badWinners = await q(`
    WITH best AS (
      SELECT DISTINCT ON (lot_id) lot_id, bidder_id
      FROM bids ORDER BY lot_id, max_amount_cents DESC, placed_at ASC)
    SELECT l.id FROM lots l JOIN best b ON b.lot_id = l.id
    WHERE l.auction_id=$1 AND l.status='won' AND l.winner_bidder_id IS DISTINCT FROM b.bidder_id`,
    [ids.auction]);

  // Invoice math: rebuild expected totals from won lots and diff.
  const badInvoices = await q(`
    WITH expected AS (
      SELECT winner_bidder_id AS bidder_id, SUM(current_bid_cents)::bigint AS subtotal
      FROM lots WHERE auction_id=$1 AND status='won' GROUP BY 1)
    SELECT i.id, i.subtotal_cents, e.subtotal AS expected_subtotal,
           i.buyer_premium_cents, ROUND(e.subtotal * $2 / 10000.0) AS expected_premium,
           i.tax_cents, ROUND((e.subtotal + ROUND(e.subtotal * $2 / 10000.0)) * $3 / 10000.0) AS expected_tax
    FROM invoices i JOIN expected e USING (bidder_id)
    WHERE i.auction_id=$1
      AND (i.subtotal_cents <> e.subtotal
        OR i.buyer_premium_cents <> ROUND(e.subtotal * $2 / 10000.0)
        OR i.tax_cents <> ROUND((e.subtotal + ROUND(e.subtotal * $2 / 10000.0)) * $3 / 10000.0))`,
    [ids.auction, CFG.BUYER_PREMIUM_BPS, CFG.TAX_RATE_BPS]);

  const [invStats] = await q(`
    SELECT count(*)::int AS invoices, count(DISTINCT bidder_id)::int AS unique_bidders,
      COALESCE(sum(total_cents),0)::bigint AS gross_cents,
      COALESCE(sum(subtotal_cents),0)::bigint AS hammer_cents,
      COALESCE(sum(buyer_premium_cents),0)::bigint AS premium_cents,
      COALESCE(sum(tax_cents),0)::bigint AS tax_cents
    FROM invoices WHERE auction_id=$1`, [ids.auction]);
  const [invLots] = await q(`
    SELECT count(*)::int AS invoice_lots,
      count(DISTINCT lot_id)::int AS distinct_lots
    FROM invoice_lots il JOIN invoices i ON i.id=il.invoice_id WHERE i.auction_id=$1`, [ids.auction]);
  const [winnersExpected] = await q(`
    SELECT count(DISTINCT winner_bidder_id)::int AS n FROM lots WHERE auction_id=$1 AND status='won'`,
    [ids.auction]);

  // Close-tail: how late did lots actually finalize vs nominal schedule?
  const [tail] = await q(`
    SELECT max(closed_at)::timestamptz AS last_finalized,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (closed_at - close_at))) AS median_lag_s,
      max(EXTRACT(EPOCH FROM (closed_at - close_at))) AS max_lag_s
    FROM lots WHERE auction_id=$1 AND closed_at IS NOT NULL`, [ids.auction]);

  const rowCounts = await q(`
    SELECT relname, n_live_tup::bigint AS rows FROM pg_stat_user_tables
    WHERE relname IN ('bids','lots','invoices','invoice_lots','auto_charge_jobs',
      'lot_status_history','invoice_status_history','notifications','operator_bidder_relations',
      'image_enrichment_jobs','build_invoice_jobs')
    ORDER BY n_live_tup DESC`);
  const dbSize = (await q(`SELECT pg_size_pretty(pg_database_size('stress_sim')) AS s`))[0].s;

  const [bidStats] = await q(`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE is_auto)::int AS auto FROM bids`);

  // Engine tick timing by function
  const tickStats = {};
  for (const t of M.ticks) {
    (tickStats[t.fn] ??= []).push(t.ms);
  }
  const tickSummary = Object.fromEntries(Object.entries(tickStats).map(([fn, arr]) => [fn, {
    n: arr.length, p50: pct(arr, 50).toFixed(1), p95: pct(arr, 95).toFixed(1), max: Math.max(...arr).toFixed(1),
  }]));
  const maxBacklog = Math.max(0, ...M.backlog.map((b) => b.due));

  const report = {
    config: CFG,
    durationSec: Number(rel(Date.now())),
    bids: {
      rpcCalls: M.bidLatencies.length,
      results: M.bidResults,
      latencyMs: {
        p50: pct(M.bidLatencies, 50).toFixed(1),
        p95: pct(M.bidLatencies, 95).toFixed(1),
        p99: pct(M.bidLatencies, 99).toFixed(1),
        max: Math.max(0, ...M.bidLatencies).toFixed(1),
      },
      softCloseExtensions: M.extensions,
      bidRows: bidStats,
    },
    lots: lotStats,
    closeTail: tail,
    finalizeMaxBacklog: maxBacklog,
    engineTicks: tickSummary,
    invoices: { ...invStats, ...invLots, winnersExpected: winnersExpected.n, chargeMix },
    correctness: {
      wrongWinners: badWinners.length,
      badInvoiceMath: badInvoices.length,
      badInvoiceSample: badInvoices.slice(0, 3),
      lotsNotTerminal: lotStats.other,
    },
    rows: rowCounts,
    dbSize,
    errors: M.errors.slice(0, 20),
  };
  writeFileSync(new URL('./report.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await engine.connect();
  await admin.connect();
  await setup();
  const engineP = engineLoop();
  await bidLoad();
  await waitForQuiescence();
  engineStop = true;
  await engineP;
  const chargeMix = await mockChargeWorker();
  await verifyAndReport(chargeMix);
  await bidPool.end();
  await engine.end();
  await admin.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
