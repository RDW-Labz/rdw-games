// Money totals for /reports — computed in the DATABASE, never from page rows.
//
// Mig 0421: sales are bucketed on the invoice's paid_at, refunds on the date
// each refund was issued (the Money page does the same), so totals can be
// negative for a period with more refunds than sales.
//
// 2026-10-14: /reports used to load the period's invoices with .limit(1000)
// and sum them in JS, so a range with 1,677 invoices showed net revenue
// $25,295.63 instead of $41,846.26. Every total now comes from
// operator_reports_period_summary (mig 0418), which uses the same money
// definitions as operator_money_summary so /reports matches /reports/money.
// The invoice list on the page is paginated for display only.
//
// Plain module (no 'use client'): imported by the server page and unit tests.

export type ReportPeriodTotals = {
  invoices: number;
  hammerCents: number; // hammer sold − hammer share of refunds issued in the period
  premiumCents: number; // net revenue − hammer, so the cards always add up
  taxCents: number; // net sales tax (tax − tax refunded)
  totalCents: number; // net collected (gross charged − refunds), tax included
  netCents: number; // net revenue = total collected − sales tax
  grossChargedCents: number;
  refundedCents: number; // refunds issued in the period (by refund date)
};

type PeriodSummaryRow = {
  invoices: number | string | null;
  gross_charged_cents: number | string | null;
  refunded_face_cents: number | string | null;
  net_collected_cents: number | string | null;
  net_tax_cents: number | string | null;
  net_revenue_cents: number | string | null;
  hammer_net_cents: number | string | null;
  premium_net_cents: number | string | null;
};

/** The one RPC call this module needs — keeps tests free of a full client. */
export type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export const REPORT_TOTALS_RPC = 'operator_reports_period_summary';

const n = (v: number | string | null | undefined): number => {
  const x = typeof v === 'string' ? Number(v) : (v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export function mapPeriodSummary(raw: unknown): ReportPeriodTotals {
  const r = (raw ?? {}) as Partial<PeriodSummaryRow>;
  return {
    invoices: n(r.invoices),
    hammerCents: n(r.hammer_net_cents),
    premiumCents: n(r.premium_net_cents),
    taxCents: n(r.net_tax_cents),
    totalCents: n(r.net_collected_cents),
    netCents: n(r.net_revenue_cents),
    grossChargedCents: n(r.gross_charged_cents),
    refundedCents: n(r.refunded_face_cents),
  };
}

/**
 * Totals for [startISO, endISO): sales by paid_at, refunds by refund date.
 * Returns `error` instead of zeros
 * when the RPC fails — a confident $0 is indistinguishable from a real zero.
 */
export async function loadReportPeriodTotals(
  supabase: RpcClient,
  startISO: string | null,
  endISO: string | null,
): Promise<{ totals: ReportPeriodTotals | null; error: string | null }> {
  const { data, error } = await supabase.rpc(REPORT_TOTALS_RPC, {
    p_from: startISO,
    p_to: endISO,
  });
  if (error) return { totals: null, error: error.message };
  return { totals: mapPeriodSummary(data), error: null };
}

export type InvoiceMoneyInput = {
  subtotal_cents: number | null;
  buyer_premium_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  refunded_cash_cents: number | null;
  refunded_credit_cents: number | null;
  refunded_tax_cents: number | null;
};

/**
 * One invoice's money, net of refunds (mig 0270). DISPLAY ONLY — the period
 * totals use the same formula in SQL (mig 0418) over every invoice.
 * Face refunded = cash + credit returned; total drops by the full face
 * refund, tax by the face tax refunded, and the non-tax refund is prorated
 * across hammer + premium so hammer + premium == net and net == total − tax.
 */
export function invoiceRowMoney(r: InvoiceMoneyInput): {
  hammerCents: number;
  premiumCents: number;
  taxCents: number;
  totalCents: number;
  netCents: number;
} {
  const hammer = r.subtotal_cents ?? 0;
  const premium = r.buyer_premium_cents ?? 0;
  const tax = r.tax_cents ?? 0;
  const total = r.total_cents ?? 0;
  const refundedFace = (r.refunded_cash_cents ?? 0) + (r.refunded_credit_cents ?? 0);
  const refundedTax = r.refunded_tax_cents ?? 0;
  const effTotal = Math.max(0, total - refundedFace);
  const effTax = Math.max(0, tax - refundedTax);
  const effNet = Math.max(0, effTotal - effTax);
  const origNonTax = hammer + premium;
  const nonTaxRefunded = Math.max(0, refundedFace - refundedTax);
  const effHammer =
    origNonTax > 0
      ? Math.max(0, Math.round(hammer * ((origNonTax - nonTaxRefunded) / origNonTax)))
      : hammer;
  const effPremium = Math.max(0, effNet - effHammer);
  return {
    hammerCents: effHammer,
    premiumCents: effPremium,
    taxCents: effTax,
    totalCents: effTotal,
    netCents: effNet,
  };
}

/** Rows per page of the invoice LIST (display only; totals never use it). */
export const REPORT_INVOICE_PAGE_SIZE = 500;

export function parsePage(raw: string | undefined): number {
  const p = raw && /^\d{1,6}$/.test(raw) ? Number(raw) : 1;
  return p >= 1 ? p : 1;
}
