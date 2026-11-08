// /reports totals must come from the DB (mig 0418), never from loaded rows.
// Regression for 2026-10-14: a range with 1,677 invoices showed net revenue
// $25,295.63 (first 1,000 rows summed in JS) instead of $41,846.26.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  REPORT_INVOICE_PAGE_SIZE,
  REPORT_TOTALS_RPC,
  invoiceRowMoney,
  loadReportPeriodTotals,
  mapPeriodSummary,
  parsePage,
  type InvoiceMoneyInput,
  type RpcClient,
} from '../report-totals';

// 1,677 invoices, mixed refunds — more than PostgREST's 1,000-row cap.
function makeInvoices(count: number): InvoiceMoneyInput[] {
  return Array.from({ length: count }, (_, i) => {
    const hammer = 1000 + (i % 37) * 25;
    const premium = Math.round(hammer * 0.15);
    const tax = Math.round((hammer + premium) * 0.08);
    const refunded = i % 50 === 0;
    return {
      subtotal_cents: hammer,
      buyer_premium_cents: premium,
      tax_cents: tax,
      total_cents: hammer + premium + tax,
      refunded_cash_cents: refunded ? 500 : 0,
      refunded_credit_cents: 0,
      refunded_tax_cents: refunded ? 37 : 0,
    };
  });
}

// What the DB returns: operator_money_summary definitions over EVERY row.
function dbSummary(rows: InvoiceMoneyInput[]) {
  let gross = 0;
  let refunded = 0;
  let tax = 0;
  let refundedTax = 0;
  let hammer = 0;
  let premium = 0;
  for (const r of rows) {
    gross += r.total_cents ?? 0;
    refunded += (r.refunded_cash_cents ?? 0) + (r.refunded_credit_cents ?? 0);
    tax += r.tax_cents ?? 0;
    refundedTax += r.refunded_tax_cents ?? 0;
    const m = invoiceRowMoney(r);
    hammer += m.hammerCents;
    premium += m.premiumCents;
  }
  return {
    invoices: rows.length,
    gross_charged_cents: gross,
    refunded_face_cents: refunded,
    net_collected_cents: gross - refunded,
    net_tax_cents: tax - refundedTax,
    net_revenue_cents: gross - refunded - (tax - refundedTax),
    hammer_net_cents: hammer,
    premium_net_cents: premium,
  };
}

describe('loadReportPeriodTotals', () => {
  it('takes totals from the RPC, covering all 1,677 invoices — not the first 1,000', async () => {
    const all = makeInvoices(1677);
    const rpc = vi.fn(async () => ({ data: dbSummary(all), error: null }));
    // No .from(): the totals path cannot read invoice rows at all.
    const client: RpcClient = { rpc };

    const { totals, error } = await loadReportPeriodTotals(
      client,
      '2026-09-01T05:00:00.000Z',
      '2026-10-01T05:00:00.000Z',
    );

    expect(error).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(REPORT_TOTALS_RPC, {
      p_from: '2026-09-01T05:00:00.000Z',
      p_to: '2026-10-01T05:00:00.000Z',
    });
    expect(totals?.invoices).toBe(1677);

    const allNet = all.reduce((s, r) => s + invoiceRowMoney(r).netCents, 0);
    const firstThousandNet = all
      .slice(0, 1000)
      .reduce((s, r) => s + invoiceRowMoney(r).netCents, 0);
    expect(totals?.netCents).toBe(allNet);
    expect(totals?.netCents).toBeGreaterThan(firstThousandNet);
    expect(totals!.hammerCents + totals!.premiumCents).toBe(totals!.netCents);
  });

  it('returns the error instead of a confident $0 when the RPC fails', async () => {
    const client: RpcClient = {
      rpc: async () => ({ data: null, error: { message: 'not_operator_staff' } }),
    };
    const res = await loadReportPeriodTotals(client, null, null);
    expect(res).toEqual({ totals: null, error: 'not_operator_staff' });
  });

  it('keeps a refund-only period negative (mig 0421: refunds by refund date)', () => {
    // Oct 10 in the SQL test: no sales, one $30 refund (tax $2.40) on an
    // invoice paid in September. The money went out that day.
    const t = mapPeriodSummary({
      invoices: 0,
      gross_charged_cents: 0,
      refunded_face_cents: 3000,
      net_collected_cents: -3000,
      net_tax_cents: -240,
      net_revenue_cents: -2760,
      hammer_net_cents: -2400,
      premium_net_cents: -360,
    });
    expect(t.refundedCents).toBe(3000);
    expect(t.totalCents).toBe(-3000);
    expect(t.netCents).toBe(-2760);
    expect(t.hammerCents + t.premiumCents).toBe(t.netCents);
  });

  it('maps bigint-as-string JSON values', () => {
    const t = mapPeriodSummary({ invoices: '1677', net_revenue_cents: '4184626' });
    expect(t.invoices).toBe(1677);
    expect(t.netCents).toBe(4184626);
    expect(t.hammerCents).toBe(0);
  });
});

describe('invoiceRowMoney (display rows; same formula as mig 0418)', () => {
  it('prorates a partial refund across hammer + premium', () => {
    // Same case the SQL test pins: hammer 6000, premium 900.
    const m = invoiceRowMoney({
      subtotal_cents: 10000,
      buyer_premium_cents: 1500,
      tax_cents: 920,
      total_cents: 12420,
      refunded_cash_cents: 3000,
      refunded_credit_cents: 2000,
      refunded_tax_cents: 400,
    });
    expect(m).toEqual({
      hammerCents: 6000,
      premiumCents: 900,
      taxCents: 520,
      totalCents: 7420,
      netCents: 6900,
    });
  });
});

describe('parsePage', () => {
  it('defaults to 1 and rejects junk', () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-2')).toBe(1);
    expect(parsePage('abc')).toBe(1);
    expect(parsePage('3')).toBe(3);
  });
});

describe('/reports page source', () => {
  const src = readFileSync(path.resolve(__dirname, '../page.tsx'), 'utf8');

  it('gets every money total from the RPC loader', () => {
    expect(src).toContain('loadReportPeriodTotals(supabase, rangeStart, rangeEnd)');
    expect(src).toMatch(/comparisonMonths\.map\(\(c\) => loadReportPeriodTotals\(/);
  });

  it('never sums invoice rows and pages the list instead of capping it', () => {
    expect(src).not.toMatch(/\.limit\(1000\)/);
    expect(src).not.toMatch(/reportRows\.reduce/);
    expect(src).not.toMatch(/compRows/);
    expect(src).toContain('REPORT_INVOICE_PAGE_SIZE');
    expect(REPORT_INVOICE_PAGE_SIZE).toBeLessThanOrEqual(1000);
  });
});

describe('refund labels (mig 0421: refunds by refund date)', () => {
  const reports = readFileSync(path.resolve(__dirname, '../page.tsx'), 'utf8');
  const moneyPage = readFileSync(path.resolve(__dirname, '../money/page.tsx'), 'utf8');

  it('both pages label refunds by refund date', () => {
    expect(reports).toContain('Refunds (by refund date)');
    expect(reports).toContain('periodTotals?.refundedCents');
    expect(moneyPage).toContain('Refunds (by refund date)');
    expect(moneyPage).not.toContain("'− Refunds returned'");
  });

  it('Money page does not clamp net revenue, so it matches /reports on refund-heavy days', () => {
    expect(moneyPage).toContain('const netRevenue = netCollected - netTax;');
    expect(moneyPage).not.toMatch(/netRevenue = Math\.max\(0/);
  });
});
