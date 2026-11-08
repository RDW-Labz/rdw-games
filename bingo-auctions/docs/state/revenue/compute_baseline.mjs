// Recomputes the Phase 0 baseline from the saved prod query results (queries/b2.json, b4.json, b5.json).
// Run: node docs/state/revenue/compute_baseline.mjs   — prints JSON; no network, no prod access.
import { readFileSync } from 'node:fs';
const d = (f) => JSON.parse(readFileSync(new URL(`./queries/${f}`, import.meta.url)))[0];
const b2 = d('b2.json'), b4 = d('b4.json'), b5 = d('b5.json');
const full = b2.weekly.filter((w) => w.wk >= '2026-07-27' && w.wk <= '2026-10-05'); // 11 full weeks, skip partial first/last
const sum = (k) => full.reduce((a, w) => a + Number(w[k]), 0);
const wk = (k) => Math.round(sum(k) / full.length);
const out = {
  window: `${full[0].wk}..${full.at(-1).wk} (${full.length} full weeks, Central)`,
  per_week_avg_cents: {
    hammer: wk('hammer_c'), buyer_premium: wk('bp_c'), tax: wk('tax_c'), invoice_total: wk('total_c'),
    square_fees: wk('sq_fee_c'), cash_refunds: wk('refund_cash_c'), invoices: wk('invoices'), buyers: wk('buyers'),
  },
  refund_cash_share_of_total: +(sum('refund_cash_c') / sum('total_c')).toFixed(3),
  last4_vs_first4_hammer_growth: +((full.slice(-4).reduce((a, w) => a + w.hammer_c, 0) / full.slice(0, 4).reduce((a, w) => a + w.hammer_c, 0)) - 1).toFixed(3),
  lots_84d: { ...b2.lots84, sell_through: +(b2.lots84.sold / b2.lots84.closed_lots).toFixed(3),
    zero_bid_share: +(b2.lots84.zero_bid / b2.lots84.closed_lots).toFixed(3),
    hammer_to_msrp: +(b2.lots84.avg_hammer_c / b2.lots84.avg_msrp_sold_c).toFixed(3) },
  buyers_84d: { ...b2.buyers84, repeat_rate_2plus_weeks: +(b2.buyers84.buyers_2plus_weeks / b2.buyers84.buyers).toFixed(3),
    top20_hammer_share: +b5.conc.top20_share.toFixed(3),
    heavy_buyers_60plus_invoices: b5.buyer_buckets.at(-1) },
  lines_84d: { ...b2.lines84, refund_line_rate: +(b2.lines84.refunded / b2.lines84.lines).toFixed(3), forfeit_line_rate: +(b2.lines84.forfeited / b2.lines84.lines).toFixed(3) },
  forfeits_84d: b4.forfeits84, pickup_lag_days: b4.pickup_lag,
  refund_reason_recorded: b5.refund_notes.refund_rows - b5.refund_notes.null_note,
};
console.log(JSON.stringify(out, null, 2));
// NOTE 2026-10-15: refund_reason_recorded above read after_state 'reason'/'refund_reason'; the real key is 'sub_reason' (see queries/r1.json). baseline.json carries the correction.
