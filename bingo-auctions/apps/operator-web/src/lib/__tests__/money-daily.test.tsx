import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  addDaysYMD,
  fetchMoneyDaily,
  MONEY_DAY_COLUMNS,
  parseMoneyDaily,
  todayInTimeZone,
} from '../money-daily';
import { MoneyDailyTable } from '@/components/MoneyDailyTable';

// The shape operator_money_daily (mig 0417) returns for the fixture in
// packages/db/test/money_daily_revenue.sql: invoice B ($55, tax $5) was paid on
// D0 and partially refunded ($22, tax $2) on D2. It counts in full on D0 and
// its refund comes off D2 — under the old status='paid' rule D0 read $110.00.
const rpcJson = {
  tz: 'America/Chicago',
  from_day: '2026-10-01',
  to_day: '2026-10-04',
  days: [
    { day: '2026-10-01', invoices_paid: 2, gross_charged_cents: 16500, refunds_cents: 0, net_collected_cents: 16500, tax_cents: 1500, net_revenue_cents: 15000 },
    { day: '2026-10-02', invoices_paid: 2, gross_charged_cents: 4300, refunds_cents: 2100, net_collected_cents: 2200, tax_cents: 200, net_revenue_cents: 2000 },
    { day: '2026-10-03', invoices_paid: 0, gross_charged_cents: 0, refunds_cents: 2200, net_collected_cents: -2200, tax_cents: -200, net_revenue_cents: -2000 },
    { day: '2026-10-04', invoices_paid: 0, gross_charged_cents: 0, refunds_cents: 1100, net_collected_cents: -1100, tax_cents: -100, net_revenue_cents: -1000 },
  ],
  // bigint sums arrive as strings from PostgREST json
  totals: { invoices_paid: '4', gross_charged_cents: '20800', refunds_cents: '5400', net_collected_cents: '15400', tax_cents: '1400', net_revenue_cents: '14000' },
};

describe('parseMoneyDaily', () => {
  it('normalises numbers (incl. string bigints) and keeps every day', () => {
    const m = parseMoneyDaily(rpcJson);
    expect(m?.days).toHaveLength(4);
    expect(m?.totals).toEqual({
      invoices_paid: 4,
      gross_charged_cents: 20800,
      refunds_cents: 5400,
      net_collected_cents: 15400,
      tax_cents: 1400,
      net_revenue_cents: 14000,
    });
  });

  it('net revenue = net collected − tax on every row', () => {
    const m = parseMoneyDaily(rpcJson)!;
    for (const d of [...m.days, { day: 'total', ...m.totals }]) {
      expect(d.net_collected_cents).toBe(d.gross_charged_cents - d.refunds_cents);
      expect(d.net_revenue_cents).toBe(d.net_collected_cents - d.tax_cents);
    }
  });

  it('returns null for a missing / malformed payload instead of a confident $0', () => {
    expect(parseMoneyDaily(null)).toBeNull();
    expect(parseMoneyDaily({ days: 'nope' })).toBeNull();
  });
});

describe('fetchMoneyDaily', () => {
  it('calls operator_money_daily with Chicago days and degrades to null on error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: rpcJson, error: null });
    const m = await fetchMoneyDaily({ rpc }, '2026-10-01', '2026-10-04', null);
    expect(rpc).toHaveBeenCalledWith('operator_money_daily', {
      p_from_day: '2026-10-01',
      p_to_day: '2026-10-04',
      p_tz: 'America/Chicago',
    });
    expect(m?.totals.net_revenue_cents).toBe(14000);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi.fn().mockResolvedValue({ data: null, error: { message: 'missing' } });
    expect(await fetchMoneyDaily({ rpc: failing }, '2026-10-01', '2026-10-01', 'America/Chicago')).toBeNull();
    errSpy.mockRestore();
  });
});

describe('Chicago day helpers', () => {
  it('todayInTimeZone uses the warehouse wall clock, not UTC', () => {
    // 2026-10-14 02:30 UTC is still 2026-10-13 (21:30 CDT) in Chicago.
    const t = new Date('2026-10-14T02:30:00Z');
    expect(todayInTimeZone('America/Chicago', t)).toBe('2026-10-13');
    expect(todayInTimeZone(null, t)).toBe('2026-10-13');
    expect(todayInTimeZone('UTC', t)).toBe('2026-10-14');
  });

  it('addDaysYMD crosses month and year boundaries', () => {
    expect(addDaysYMD('2026-10-14', -13)).toBe('2026-10-01');
    expect(addDaysYMD('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysYMD('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('MoneyDailyTable', () => {
  const html = renderToString(<MoneyDailyTable money={parseMoneyDaily(rpcJson)!} />);

  it('labels every money column the same way everywhere', () => {
    expect(MONEY_DAY_COLUMNS.map((c) => c.label)).toEqual([
      'Gross charged',
      'Refunds',
      'Net collected',
      'Tax',
      'Net revenue',
    ]);
    for (const c of MONEY_DAY_COLUMNS) expect(html).toContain(`>${c.label}</th>`);
    expect(html).not.toContain('>Revenue</th>');
  });

  it('shows the partially refunded sale in gross on its day and the refund on the refund day', () => {
    expect(html).toContain('$165.00'); // D0 gross incl. invoice B
    expect(html).not.toContain('$110.00'); // the old status=paid figure
    expect(html).toContain('-$22.00'); // D2 net collected: B's refund
    expect(html).toContain('$140.00'); // total net revenue
  });

  it('newest day first, with a total row', () => {
    expect(html.indexOf('Oct 4')).toBeLessThan(html.indexOf('Oct 1'));
    expect(html).toContain('>Total</td>');
  });
});
