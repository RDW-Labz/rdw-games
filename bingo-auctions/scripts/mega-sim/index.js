#!/usr/bin/env node
// ============================================================================
// scripts/mega-sim/index.js
//
// Persona-driven end-to-end simulator.
//
//   Phase 1 — Operations:  operator setup → lotter → picker (intake)
//   Phase 2A — Revenue:    auctioneer → bidders → closer (no Stripe)
//   Phase 2B — Settlement: gated on Stripe Connect (not yet wired)
//
// Default = run Phase 1 + Phase 2A back-to-back on a fresh SIM operator
// (manifest → intake → auction → bids → finalize → verify winners).
//
// Usage:
//   node scripts/mega-sim                      # phase 1 + 2A (default)
//   node scripts/mega-sim --phase=1            # phase 1 only
//   node scripts/mega-sim --phase=2            # phase 2A only (still runs phase 1 setup)
//   node scripts/mega-sim --no-ai              # skip AI calls (cheap)
//   node scripts/mega-sim --cleanup            # tear down all sim operators
//   node scripts/mega-sim --keep               # don't auto-cleanup at end
//
// Output: artifacts/mega-sim/<timestamp>/{report.{json,md}, timeline.csv,
//   cost-by-task.csv, bottlenecks.md}
// ============================================================================

'use strict';

const path = require('path');
const fs = require('fs');

// ── Load env first so all subsequent imports see it ──────────────────────
const { loadEnv } = require('./lib/env');
loadEnv();

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const phaseArg = (args.find((a) => a.startsWith('--phase=')) || '').split('=')[1] || 'all';
const flags = {
  phase: phaseArg, // 'all' | '1' | '2'
  noAi: args.includes('--no-ai'),
  cleanup: args.includes('--cleanup'),
  keep: args.includes('--keep'),
  help: args.includes('--help') || args.includes('-h'),
};

if (flags.help) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 24).join('\n'));
  process.exit(0);
}

if (flags.cleanup) {
  require('./cleanup').findAndCleanupAllSim()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
  return;
}

if (!['all', '1', '2'].includes(flags.phase)) {
  console.error('[sim] --phase must be one of: all, 1, 2');
  process.exit(1);
}

// ── Imports — after env loaded ────────────────────────────────────────────
const supa = require('./lib/supa');
const cost = require('./lib/cost');
const timer = require('./lib/timer');
const assert = require('./lib/assert');
const reporter = require('./lib/reporter');
const operatorPersona = require('./personas/operator');
const lotterPersona = require('./personas/lotter');
const pickerPersona = require('./personas/picker');
const binsmithPersona = require('./personas/binsmith');
const photographerPersona = require('./personas/photographer');
const racersPersona = require('./personas/racers');
const janitorPersona = require('./personas/janitor');
const auctioneerPersona = require('./personas/auctioneer');
const biddersPersona = require('./personas/bidders');
const closerPersona = require('./personas/closer');
const pricingTiersPersona = require('./personas/pricing_tiers');
const aiBudgetPersona = require('./personas/ai_budget');
const operatorPoliciesPersona = require('./personas/operator_policies');
const accountDeleterPersona = require('./personas/account_deleter');
const cleanupModule = require('./cleanup');

const { C } = assert;

// Auto-degrade to no-ai when OPENROUTER_API_KEY is missing.
let noAi = flags.noAi;
if (!noAi && !process.env.OPENROUTER_API_KEY) {
  console.log(
    C.yellow('[sim] OPENROUTER_API_KEY not set — auto-falling back to --no-ai mode.'),
  );
  noAi = true;
}

// ── Pre-flight ────────────────────────────────────────────────────────────

function phaseLabel() {
  if (flags.phase === '1') return 'Phase 1 only (operations)';
  if (flags.phase === '2') return 'Phase 1 setup + Phase 2A (revenue path, no Stripe)';
  return 'Phase 1 + Phase 2A (default)';
}

function preflight() {
  console.log(C.bold('Mega-Sim') + ' — ' + phaseLabel());
  console.log('  Supabase URL:        ' + (supa.SUPABASE_URL || C.red('(missing)')));
  console.log('  Service role:        ' + (supa.SUPABASE_SERVICE_ROLE ? 'set' : C.red('(missing)')));
  console.log('  Anon key:            ' + (supa.SUPABASE_ANON ? 'set' : C.red('(missing)')));
  console.log('  AI mode:             ' + (noAi ? 'stubbed (no-ai)' : 'live (real OpenRouter calls)'));
  console.log('  OPENROUTER_API_KEY:  ' + (process.env.OPENROUTER_API_KEY ? 'set' : '(unset)'));
  console.log('  Auto-cleanup:        ' + (flags.keep ? 'NO (--keep)' : 'yes'));
  console.log('');

  if (!supa.SUPABASE_URL || !supa.SUPABASE_SERVICE_ROLE || !supa.SUPABASE_ANON) {
    console.error(C.red('[sim] Required env vars are missing. See above.'));
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  preflight();

  // Wire cost telemetry early so any AI call gets captured.
  if (!noAi) cost.attachToDomainLotting();

  const startedAt = new Date().toISOString();
  const startedDir = startedAt.replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', '..', 'artifacts', 'mega-sim', startedDir);

  let ctx = null;
  let runError = null;

  // Phase routing — '2' still needs phase-1 setup because the auctioneer
  // needs in_inventory lots. So phase=2 = run everything; phase=1 = stop
  // after picker; default ('all') = run everything.
  const runPhase1 = true;
  const runPhase2 = flags.phase === '2' || flags.phase === 'all';

  try {
    ctx = await operatorPersona.setup({ operatorPrefix: 'SIM' });
    if (runPhase1) {
      await lotterPersona.run({ ctx, noAi });
      await pickerPersona.run({ ctx });
      await binsmithPersona.run({ ctx });
      await photographerPersona.run({ ctx });
      await racersPersona.run({ ctx });
    }
    if (runPhase2) {
      await janitorPersona.run({ ctx });
      await auctioneerPersona.run({ ctx });
      await biddersPersona.run({ ctx });
      await closerPersona.run({ ctx });
      await pricingTiersPersona.run({ ctx });
      await aiBudgetPersona.run({ ctx });
      await operatorPoliciesPersona.run({ ctx });
      await accountDeleterPersona.run({ ctx });
    }
  } catch (e) {
    runError = e;
    console.error(C.red('\n[sim] uncaught error: ' + (e.stack || e.message)));
  }

  // ── Report ──────────────────────────────────────────────────────────
  const meta = {
    phase: flags.phase,
    startedAt,
    operator: ctx ? ctx.operatorCode + ' (' + ctx.operatorId + ')' : null,
    noAi,
    runError: runError ? runError.message : null,
  };
  const { report } = reporter.writeReports(outDir, meta);

  // ── Console summary ─────────────────────────────────────────────────
  console.log('\n' + C.bold('── Summary ' + '─'.repeat(60)));
  const passLine =
    report.summary.failed === 0
      ? C.green('✓ All ' + report.summary.passed + ' / ' + report.summary.total + ' steps passed')
      : C.red('✗ ' + report.summary.passed + ' / ' + report.summary.total + ' steps passed (' + report.summary.failed + ' failed)');
  console.log('  ' + passLine);
  console.log('  AI cost:   ' + reporter.fmtUsd(report.summary.totalCostUsd) + ' (' + report.summary.totalAiCalls + ' calls)');
  console.log('  Wall time: ' + reporter.fmtMs(report.summary.wallTimeMs));
  console.log('  Reports:   ' + outDir);

  // ── Cleanup ────────────────────────────────────────────────────────
  if (ctx && !flags.keep) {
    console.log('\n' + C.dim('[sim] cleaning up SIM operator (use --keep to retain)'));
    try {
      await cleanupModule.cleanup({
        operatorId: ctx.operatorId,
        adminUserId: ctx.adminUserId,
        pickerUserId: ctx.pickerUserId,
        bidderUserIds: ctx.bidders
          ? Object.values(ctx.bidders).map((b) => b.userId)
          : [],
        tombstonedBidderIds: ctx.tombstonedBidderIds || [],
        policyTestBidderId: ctx.policyTestBidderId || null,
      });
    } catch (e) {
      console.error(C.red('[sim] cleanup failed: ' + e.message));
    }
  } else if (ctx && flags.keep) {
    console.log('\n' + C.yellow('[sim] --keep: SIM operator retained at ' + ctx.operatorId));
    console.log(C.dim('[sim] tear down later with: node scripts/mega-sim --cleanup'));
  }

  // Exit code: 0 if all steps passed AND no uncaught error
  process.exit(report.summary.failed === 0 && !runError ? 0 : 1);
}

main().catch((e) => {
  console.error(C.red('[sim] FATAL: ' + (e.stack || e.message)));
  process.exit(2);
});
