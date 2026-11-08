// scripts/mega-sim/personas/pricing_tiers.js
//
// Persona: verifies compute_application_fee_cents() bracket math.
//
// Tests:
//   1. Founder pricing: $0 MTD + $5k sale → 2.0% on full $5k = $100
//   2. Founder pricing straddle: $300 MTD + $50k sale crosses the $25k
//      boundary. First $24,700 at 2.0%, remaining $25,300 at 1.5%
//      = $494 + $379.50 = $873.50 → 87350 cents (±100 cents tolerance)
//   3. Standard pricing: $0 MTD + $5k sale → 2.5% = $125
//
// All requires service-role writes to insert fake paid invoices and to
// toggle founder_pricing. Cleans up after itself.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

async function run({ ctx }) {
  setPhase('Pricing Tiers');

  if (!ctx.operatorId) {
    await step('prereq: operatorId present', async () => {
      expect(false).toBeTruthy('ctx.operatorId missing — operator setup failed');
    });
    return;
  }

  // Track inserted invoice ids for cleanup.
  const insertedInvoiceIds = [];

  // ── Baseline: set founder_pricing = TRUE for this test ───────────────────
  // Migration 0087 backfills existing operators, but the SIM operator is
  // created fresh after the migration ran, so its default is founder_pricing=FALSE.
  // We explicitly enable founder pricing so we can test the discounted rates.
  // We also set founder_locked_until to 1 year from now so the function
  // doesn't short-circuit back to standard rates.
  await step('set operator to founder_pricing for test (starter tier)', async () => {
    const lockedUntil = new Date();
    lockedUntil.setFullYear(lockedUntil.getFullYear() + 1);
    const lockedUntilDate = lockedUntil.toISOString().slice(0, 10); // YYYY-MM-DD

    const { value } = await time('supa.update.operators.enableFounder', () =>
      supa.supaUpdate(
        null,
        'operators',
        'id=eq.' + ctx.operatorId,
        {
          founder_pricing: true,
          founder_locked_until: lockedUntilDate,
          subscription_tier: 'starter',
        },
        true,
      ),
    );
    expect(value.error).toBeNull();
    console.log('      [pricing] founder_pricing=true locked_until=' + lockedUntilDate);
  });

  // ── Read baseline operator config (verify write took) ────────────────────
  await step('verify operator subscription_tier=starter + founder_pricing=true', async () => {
    const { value } = await time('supa.select.operators.pricingConfig', () =>
      supa.supaSelect(
        null,
        'operators',
        'id=eq.' + ctx.operatorId,
        'subscription_tier,founder_pricing,founder_locked_until',
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(1);
    const op = value.data[0];
    expect(op.subscription_tier).toBe('starter');
    expect(op.founder_pricing).toBe(true);
    console.log(
      '      [pricing] tier=' + op.subscription_tier +
      ' founder=' + op.founder_pricing +
      ' locked_until=' + op.founder_locked_until,
    );
  });

  // ── Test 1: Founder, $0 MTD, $5k sale ─────────────────────────────────────
  // Expected: 2.0% of $5,000 = $100.00 = 10000 cents
  await step('founder $0 MTD + $5k sale → 10000 cents (2.0%)', async () => {
    const { value } = await time('rpc.compute_application_fee_cents.founder_zero_mtd', () =>
      supa.supaRpc(null, 'compute_application_fee_cents', {
        p_operator_id: ctx.operatorId,
        p_sale_amount_cents: 500000, // $5,000
      }, true),
    );
    expect(value.error).toBeNull();
    // Supabase REST returns a scalar RPC as the bare value.
    const fee = typeof value.data === 'number' ? value.data : parseInt(value.data, 10);
    console.log('      [pricing] test1 fee=' + fee + ' cents (expected 10000)');
    // 2.0% of $5,000 = $100 = 10000 cents
    expect(fee).toBe(10000);
  });

  // ── Insert a fake paid invoice to simulate $300 MTD GMV ───────────────────
  // We need a real auction_id + bidder_id to satisfy the invoices FKs.
  // Use the existing auction and bidder A from the bidder phase if available,
  // otherwise skip the straddle test.
  let fakeInvoiceId = null;
  let straddleSkipped = false;

  if (ctx.auctionId && ctx.bidders && ctx.bidders.A) {
    await step('insert fake paid invoice ($300 GMV) for straddle test', async () => {
      // total_cents = 30000 ($300), tax_cents = 0, so fee base = 30000 cents
      const { value } = await time('supa.insert.invoices.fake_mtd', () =>
        supa.supaInsert(
          null,
          'invoices',
          {
            operator_id: ctx.operatorId,
            // Use a deterministic unique auction_id/bidder_id combo.
            // Re-use the existing auction_id but with a unique-enough combo
            // by using a fake bidder_id approach — actually the invoices table
            // has UNIQUE (auction_id, bidder_id), so we need an unused pair.
            // Insert with a fake bidder record if the bidder has no invoice yet,
            // or just use bidder B who probably doesn't have an invoice for
            // this auction.
            auction_id: ctx.auctionId,
            bidder_id: ctx.bidders.B.userId,
            status: 'paid',
            subtotal_cents: 30000,
            buyer_premium_cents: 0,
            tax_cents: 0,
            total_cents: 30000,
            application_fee_cents: 0,
            paid_at: new Date().toISOString(),
          },
          true,
        ),
      );
      if (value.error) {
        // Possible conflict if bidder B already has an invoice (e.g. they
        // won a lot). That's OK — note it and skip the straddle test.
        console.log(
          '      [pricing] could not insert fake invoice (' +
          JSON.stringify(value.error).slice(0, 120) +
          ') — skipping straddle test',
        );
        straddleSkipped = true;
        return;
      }
      fakeInvoiceId = value.data.id;
      insertedInvoiceIds.push(fakeInvoiceId);
      console.log('      [pricing] inserted fake invoice ' + fakeInvoiceId);
    });
  } else {
    straddleSkipped = true;
    await step('prereq: auctionId + bidder B present for straddle test', async () => {
      // Soft skip — document the gap, don't fail.
      console.log('      [pricing] no auctionId/bidders in ctx — straddle test skipped');
      expect(true).toBe(true);
    });
  }

  // ── Test 2: Founder straddle — $300 MTD + $50k sale ───────────────────────
  // MTD running = $300 = 30000 cents
  // Sale = $50,000 = 5000000 cents
  // Bracket 1 top = $25,000 = 2500000 cents (founder: 2.0%)
  // Bracket 2 top = $100,000 = 10000000 cents (founder: 1.5%)
  //
  // amt_in_b1 = LEAST(30000 + 5000000, 2500000) - LEAST(30000, 2500000)
  //           = 2500000 - 30000 = 2470000 ($24,700 @ 2.0%)
  // amt_in_b2 = LEAST(5030000, 10000000) - GREATEST(30000, 2500000)
  //           = 5030000 - 2500000 = 2530000 ($25,300 @ 1.5%)
  // amt_in_b3 = 0 (5030000 < 10000000)
  //
  // fee = ROUND(2470000 * 200 / 10000.0) + ROUND(2530000 * 150 / 10000.0)
  //     = ROUND(49400) + ROUND(37950)
  //     = 49400 + 37950 = 87350 cents  ($873.50)
  if (!straddleSkipped) {
    await step('founder straddle: $300 MTD + $50k sale → ~87350 cents (±100)', async () => {
      const { value } = await time('rpc.compute_application_fee_cents.straddle', () =>
        supa.supaRpc(null, 'compute_application_fee_cents', {
          p_operator_id: ctx.operatorId,
          p_sale_amount_cents: 5000000, // $50,000
        }, true),
      );
      expect(value.error).toBeNull();
      const fee = typeof value.data === 'number' ? value.data : parseInt(value.data, 10);
      console.log('      [pricing] test2 fee=' + fee + ' cents (expected ~87350)');
      // Allow ±100 cents (±$1) rounding tolerance.
      expect(Math.abs(fee - 87350) <= 100).toBe(true);
    });
  } else {
    await step('founder straddle test (skipped — no fake invoice)', async () => {
      console.log('      [pricing] straddle test skipped');
      expect(true).toBe(true);
    });
  }

  // ── Switch to standard (non-founder) pricing ──────────────────────────────
  await step('set operator founder_pricing = FALSE for standard test', async () => {
    const { value } = await time('supa.update.operators.disableFounder', () =>
      supa.supaUpdate(
        null,
        'operators',
        'id=eq.' + ctx.operatorId,
        { founder_pricing: false },
        true,
      ),
    );
    expect(value.error).toBeNull();
  });

  // ── Test 3: Standard, $0 MTD, $5k sale ────────────────────────────────────
  // To ensure $0 MTD: delete the fake invoice first (or check that the
  // straddle test was skipped). If straddle was NOT skipped, the fake
  // invoice exists so MTD = $300. We still can do the $0-MTD test by
  // deleting the fake invoice before calling. If it was skipped, MTD is
  // already $0 (or whatever the closed auction produced — but the newly
  // inserted fake invoice is what matters for the function, and those
  // are the only paid invoices from today).
  //
  // Simplification: if fake invoice exists, delete it before this test.
  if (fakeInvoiceId) {
    await step('remove fake invoice to reset MTD to $0 for standard test', async () => {
      const { value } = await time('supa.delete.invoices.fake', () =>
        supa.supaDelete(null, 'invoices', 'id=eq.' + fakeInvoiceId, true),
      );
      expect(value.error).toBeNull();
      // Mark cleaned up so final cleanup block skips it.
      insertedInvoiceIds.length = 0;
      fakeInvoiceId = null;
    });
  }

  // Expected: 2.5% of $5,000 = $125.00 = 12500 cents
  await step('standard $0 MTD + $5k sale → 12500 cents (2.5%)', async () => {
    const { value } = await time('rpc.compute_application_fee_cents.standard', () =>
      supa.supaRpc(null, 'compute_application_fee_cents', {
        p_operator_id: ctx.operatorId,
        p_sale_amount_cents: 500000, // $5,000
      }, true),
    );
    expect(value.error).toBeNull();
    const fee = typeof value.data === 'number' ? value.data : parseInt(value.data, 10);
    console.log('      [pricing] test3 fee=' + fee + ' cents (expected 12500)');
    expect(fee).toBe(12500);
  });

  // ── Restore founder_pricing ────────────────────────────────────────────────
  await step('restore operator founder_pricing = TRUE', async () => {
    const { value } = await time('supa.update.operators.restoreFounder', () =>
      supa.supaUpdate(
        null,
        'operators',
        'id=eq.' + ctx.operatorId,
        { founder_pricing: true },
        true,
      ),
    );
    expect(value.error).toBeNull();
  });

  // ── Cleanup any remaining fake invoices ───────────────────────────────────
  if (insertedInvoiceIds.length > 0) {
    await step('cleanup: delete remaining fake invoices', async () => {
      for (const id of insertedInvoiceIds) {
        await supa.supaDelete(null, 'invoices', 'id=eq.' + id, true);
      }
      expect(true).toBe(true);
    });
  }
}

module.exports = { run };
