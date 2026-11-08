// Per-day money, one calculation for every revenue figure in the console.
//
// WHY (2026-10-14): Reports → Health "Revenue" and Ops "Revenue today" summed
// invoices.total_cents WHERE status = 'paid'. A partial refund moves an invoice
// to 'partially_refunded', so the WHOLE invoice — not just the refunded part —
// dropped out of revenue: Sept 30–Oct 12 read $37.6k against $52.3k actually
// charged. Every revenue figure now comes from operator_money_daily (mig 0417),
// which uses the Money page's rules (operator_money_summary, mig 0287):
//
//   Gross charged  = invoice total (incl. tax) of every paid, partially
//                    refunded or refunded invoice, on its paid_at day
//   Refunds        = face value returned (cash + store credit), on the day the
//                    refund was issued — from operator_refund_ledger (mig
//                    0421, read by operator_money_daily since mig 0422), the
//                    same rows the Money page and /reports use
//   Net collected  = Gross charged − Refunds
//   Tax            = tax charged that day − tax refunded that day
//   Net revenue    = Net collected − Tax  (winning bids + buyer's premium −
//                    refunds, excluding sales tax)
//
// Days are calendar days in the warehouse time zone (America/Chicago for
// BinGo). A refund issued today on last week's sale lowers TODAY, so a day's
// figure can be negative and a closed day never changes after the fact.

import { DEFAULT_TIME_ZONE } from '@/lib/datetime';

export type MoneyDay = {
  day: string; // YYYY-MM-DD in the warehouse zone
  invoices_paid: number;
  gross_charged_cents: number;
  refunds_cents: number;
  net_collected_cents: number;
  tax_cents: number;
  net_revenue_cents: number;
};

export type MoneyDaily = {
  tz: string;
  from_day: string;
  to_day: string;
  days: MoneyDay[];
  totals: Omit<MoneyDay, 'day'>;
};

const ZERO: Omit<MoneyDay, 'day'> = {
  invoices_paid: 0,
  gross_charged_cents: 0,
  refunds_cents: 0,
  net_collected_cents: 0,
  tax_cents: 0,
  net_revenue_cents: 0,
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function parseRow(r: Record<string, unknown>): Omit<MoneyDay, 'day'> {
  return {
    invoices_paid: num(r['invoices_paid']),
    gross_charged_cents: num(r['gross_charged_cents']),
    refunds_cents: num(r['refunds_cents']),
    net_collected_cents: num(r['net_collected_cents']),
    tax_cents: num(r['tax_cents']),
    net_revenue_cents: num(r['net_revenue_cents']),
  };
}

/** Normalise the RPC's json (bigint sums may arrive as strings). null = RPC missing / failed. */
export function parseMoneyDaily(data: unknown): MoneyDaily | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d['days'])) return null;
  const days = (d['days'] as Array<Record<string, unknown>>).map((r) => ({
    day: String(r['day']),
    ...parseRow(r),
  }));
  const totals =
    d['totals'] && typeof d['totals'] === 'object'
      ? parseRow(d['totals'] as Record<string, unknown>)
      : { ...ZERO };
  return {
    tz: String(d['tz'] ?? DEFAULT_TIME_ZONE),
    from_day: String(d['from_day'] ?? ''),
    to_day: String(d['to_day'] ?? ''),
    days,
    totals,
  };
}

/** Today's calendar date ('YYYY-MM-DD') as observed in `timeZone`. */
export function todayInTimeZone(timeZone: string | null | undefined, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || DEFAULT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Calendar arithmetic on a 'YYYY-MM-DD' string (no time zone involved). */
export function addDaysYMD(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return t.toISOString().slice(0, 10);
}

type RpcClient = {
  rpc: (
    fn: 'operator_money_daily',
    args: { p_from_day: string; p_to_day: string; p_tz: string },
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** Inclusive [fromDay, toDay] in `timeZone`. Returns null when the RPC is unavailable. */
export async function fetchMoneyDaily(
  supabase: unknown,
  fromDay: string,
  toDay: string,
  timeZone: string | null | undefined,
): Promise<MoneyDaily | null> {
  const { data, error } = await (supabase as RpcClient).rpc('operator_money_daily', {
    p_from_day: fromDay,
    p_to_day: toDay,
    p_tz: timeZone || DEFAULT_TIME_ZONE,
  });
  if (error) {
    console.error('[money-daily] operator_money_daily failed', error.message);
    return null;
  }
  return parseMoneyDaily(data);
}

/** Column definitions shared by every per-day money table, so the labels can't drift. */
export const MONEY_DAY_COLUMNS: ReadonlyArray<{
  key: keyof Omit<MoneyDay, 'day' | 'invoices_paid'>;
  label: string;
  title: string;
}> = [
  {
    key: 'gross_charged_cents',
    label: 'Gross charged',
    title: 'Invoice totals incl. tax, counted on the day the card was charged (paid_at)',
  },
  {
    key: 'refunds_cents',
    label: 'Refunds',
    title: 'Money returned (cash + store credit), counted on the day the refund was issued',
  },
  {
    key: 'net_collected_cents',
    label: 'Net collected',
    title: 'Gross charged − refunds (incl. tax)',
  },
  {
    key: 'tax_cents',
    label: 'Tax',
    title: 'Sales tax charged that day − tax refunded that day; owed to the state, not revenue',
  },
  {
    key: 'net_revenue_cents',
    label: 'Net revenue',
    title: "Winning bids + buyer's premium − refunds, excluding sales tax",
  },
];
