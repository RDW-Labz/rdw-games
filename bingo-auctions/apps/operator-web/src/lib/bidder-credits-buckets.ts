// Scope 04 / #893: additive bidder_credits cash/credit buckets.
// Flag OFF by default, fail closed. Do not call from applyCreditToInvoice
// or auto-charge-drain in this slice (#894). Wallet loads are liabilities.

export const BIDDER_CREDIT_BUCKETS_ENV = 'BIDDER_CREDIT_BUCKETS_ENABLED';

export const UNIQUE_VIOLATION = '23505';

/** Recoverable card decline must not reverse spend (master today). */
export const REVERSE_CREDIT_ON_RECOVERABLE_DECLINE = false;

export const LEGACY_CREDIT_REASONS = [
  'referral_earn',
  'referral_welcome',
  'spend',
  'spend_reversal',
  'manual',
  'loyalty_redeem',
  'promo',
  'refund_return',
] as const;

export const NEW_CREDIT_REASONS = [
  'wallet_load',
  'refund_as_credit',
  'credit_bonus',
  'cash_out',
  'adjustment',
  'boost_cancel_credit',
] as const;

export const WALLET_LOAD_REVENUE_SOURCES: readonly string[] = [];

export type CreditBucket = 'cash' | 'credit';
export type LedgerGateReason = 'disabled' | 'denied' | 'dependency_missing';

export type LedgerWrite = {
  bidderId: string;
  amountCents: number;
  reason: string;
  invoiceId?: string | null;
  relatedBidderId?: string | null;
  bucket?: CreditBucket | null;
  spendCreditCents?: number | null;
  spendCashCents?: number | null;
  ownerKind?: 'bidder' | 'business' | null;
  businessId?: string | null;
  idempotencyKey?: string | null;
  squarePaymentId?: string | null;
  squareRefundId?: string | null;
  actorUserId?: string | null;
  actorStaffName?: string | null;
  note?: string | null;
};

export type LedgerClient = {
  rpc: (
    fn: string,
    args: { p_bidder_id: string; p_bucket: string },
  ) => PromiseLike<{ data: number | null; error: { message: string } | null }>;
  from: (table: string) => {
    insert: (
      row: Record<string, unknown>,
    ) => PromiseLike<{ error: { code?: string; message: string } | null }>;
  };
};

export function isBidderCreditBucketsEnabled(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[BIDDER_CREDIT_BUCKETS_ENV];
  return typeof raw === 'string' && (raw.trim().toLowerCase() === 'true' || raw.trim() === '1');
}

export function cardRemainderCents(totalCents: number, recordedSpendCents: number): number {
  return totalCents - recordedSpendCents;
}

export function uniqueViolationAlreadyDone(code: string | undefined | null): boolean {
  return code === UNIQUE_VIOLATION;
}

function hasNewShape(row: LedgerWrite): boolean {
  return (
    row.bucket != null ||
    row.spendCreditCents != null ||
    row.spendCashCents != null ||
    row.ownerKind === 'business' ||
    row.businessId != null ||
    row.idempotencyKey != null ||
    row.squarePaymentId != null ||
    row.squareRefundId != null ||
    row.actorUserId != null ||
    row.actorStaffName != null ||
    row.note != null
  );
}

function isNewReason(reason: string): boolean {
  return (NEW_CREDIT_REASONS as readonly string[]).includes(reason);
}

function legacyPayload(row: LedgerWrite): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    bidder_id: row.bidderId,
    amount_cents: row.amountCents,
    reason: row.reason,
  };
  if (row.invoiceId) payload.invoice_id = row.invoiceId;
  if (row.relatedBidderId) payload.related_bidder_id = row.relatedBidderId;
  return payload;
}

export function ledgerInsertGate(
  row: LedgerWrite,
  enabled: boolean,
): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: LedgerGateReason } {
  if (!enabled) {
    if (isNewReason(row.reason) || hasNewShape(row)) return { ok: false, reason: 'disabled' };
    if (!(LEGACY_CREDIT_REASONS as readonly string[]).includes(row.reason)) {
      return { ok: false, reason: 'denied' };
    }
    return { ok: true, payload: legacyPayload(row) };
  }
  if (row.ownerKind === 'business' && (row.bucket !== 'credit' || (row.spendCashCents ?? 0) > 0)) {
    return { ok: false, reason: 'denied' };
  }
  if (
    (row.reason === 'spend' || row.reason === 'spend_reversal') &&
    (row.spendCreditCents != null || row.spendCashCents != null)
  ) {
    const credit = row.spendCreditCents ?? 0;
    const cash = row.spendCashCents ?? 0;
    if (credit < 0 || cash < 0) return { ok: false, reason: 'denied' };
    const expected = row.reason === 'spend' ? -(credit + cash) : credit + cash;
    if (row.amountCents !== expected) return { ok: false, reason: 'denied' };
  }
  const payload: Record<string, unknown> = {
    ...legacyPayload(row),
    bucket: row.reason === 'spend' || row.reason === 'spend_reversal' ? null : (row.bucket ?? null),
  };
  if (row.spendCreditCents != null) payload.spend_credit_cents = row.spendCreditCents;
  if (row.spendCashCents != null) payload.spend_cash_cents = row.spendCashCents;
  if (row.ownerKind) payload.owner_kind = row.ownerKind;
  if (row.businessId) payload.business_id = row.businessId;
  if (row.idempotencyKey) payload.idempotency_key = row.idempotencyKey;
  if (row.squarePaymentId) payload.square_payment_id = row.squarePaymentId;
  if (row.squareRefundId) payload.square_refund_id = row.squareRefundId;
  if (row.actorUserId) payload.actor_user_id = row.actorUserId;
  if (row.actorStaffName) payload.actor_staff_name = row.actorStaffName;
  if (row.note) payload.note = row.note;
  return { ok: true, payload };
}

export function authorizeBucketAccess(args: {
  enabled: boolean;
  actorBidderId: string;
  targetBidderId: string;
  ownerKind?: 'bidder' | 'business';
  bucket?: CreditBucket;
}): LedgerGateReason | null {
  if (!args.enabled) return 'disabled';
  if (args.actorBidderId !== args.targetBidderId) return 'denied';
  if (args.ownerKind === 'business' && args.bucket === 'cash') return 'denied';
  return null;
}

export async function readBucketBalanceCents(
  admin: LedgerClient,
  args: { bidderId: string; bucket: CreditBucket },
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; cents: number } | { ok: false; reason: LedgerGateReason }> {
  if (!isBidderCreditBucketsEnabled(env)) return { ok: false, reason: 'disabled' };
  try {
    const { data, error } = await admin.rpc('bidder_bucket_balance_cents', {
      p_bidder_id: args.bidderId,
      p_bucket: args.bucket,
    });
    if (error || data == null || !Number.isInteger(data)) {
      return { ok: false, reason: 'dependency_missing' };
    }
    return { ok: true, cents: data };
  } catch {
    return { ok: false, reason: 'dependency_missing' };
  }
}

export async function insertBidderCreditRow(
  admin: LedgerClient,
  row: LedgerWrite,
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): Promise<
  | { ok: true; status: 'inserted' | 'already' }
  | { ok: false; reason: LedgerGateReason }
> {
  const gated = ledgerInsertGate(row, isBidderCreditBucketsEnabled(env));
  if (!gated.ok) return gated;
  try {
    const { error } = await admin.from('bidder_credits').insert(gated.payload);
    if (!error) return { ok: true, status: 'inserted' };
    if (uniqueViolationAlreadyDone(error.code)) return { ok: true, status: 'already' };
    return { ok: false, reason: 'dependency_missing' };
  } catch {
    return { ok: false, reason: 'dependency_missing' };
  }
}
