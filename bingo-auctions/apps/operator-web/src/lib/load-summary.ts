export type LoadSummary = {
  lots: number;
  sold: number;
  unsold: number;
  relistCopies: number;
  invoiceLines: number;
  refundedLines: number;
  forfeitedLines: number;
  hammerCents: number;
  premiumCents: number;
  grossCents: number;
  refundsCents: number;
  netRevenueCents: number;
  costCents: number | null;
  profitCents: number | null;
};

function coerceCount(value: unknown): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function coerceNullableCents(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseLoadSummary(raw: unknown): LoadSummary | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    lots: coerceCount(o.lots),
    sold: coerceCount(o.sold),
    unsold: coerceCount(o.unsold),
    relistCopies: coerceCount(o.relist_copies),
    invoiceLines: coerceCount(o.invoice_lines),
    refundedLines: coerceCount(o.refunded_lines),
    forfeitedLines: coerceCount(o.forfeited_lines),
    hammerCents: coerceCount(o.hammer_cents),
    premiumCents: coerceCount(o.premium_cents),
    grossCents: coerceCount(o.gross_cents),
    refundsCents: coerceCount(o.refunds_cents),
    netRevenueCents: coerceCount(o.net_revenue_cents),
    costCents: coerceNullableCents(o.purchase_cost_cents),
    profitCents: coerceNullableCents(o.profit_cents),
  };
}

export type SummaryState =
  | { kind: 'ok'; summary: LoadSummary }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

export function summaryStateFrom(
  data: unknown,
  error: { code?: string; message?: string } | null,
): SummaryState {
  if (error) {
    if (
      error.code === '42501' ||
      (error.message != null && error.message.includes('load_summary_forbidden'))
    ) {
      return { kind: 'forbidden' };
    }
    if (error.code === 'PGRST202') {
      return { kind: 'unavailable' };
    }
    return { kind: 'error', message: error.message ?? 'Unknown error' };
  }

  const summary = parseLoadSummary(data);
  if (!summary) {
    return { kind: 'error', message: 'Unexpected response' };
  }
  return { kind: 'ok', summary };
}
