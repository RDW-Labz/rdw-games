import { describe, expect, it } from 'vitest';
import { GROWTH_REVENUE_SOURCES } from '../growth-hub';
import {
  BIDDER_CREDIT_BUCKETS_ENV,
  REVERSE_CREDIT_ON_RECOVERABLE_DECLINE,
  WALLET_LOAD_REVENUE_SOURCES,
  authorizeBucketAccess,
  cardRemainderCents,
  insertBidderCreditRow,
  isBidderCreditBucketsEnabled,
  ledgerInsertGate,
  readBucketBalanceCents,
  uniqueViolationAlreadyDone,
  type LedgerClient,
} from '../bidder-credits-buckets';

const BIDDER = '89300000-0000-4000-8000-00000000000a';
const OTHER = '89300000-0000-4000-8000-00000000000b';
const INVOICE = '89300000-0000-4000-8000-0000000000a1';

const off = {};
const on = { [BIDDER_CREDIT_BUCKETS_ENV]: 'true' };

function client(opts: {
  rpcError?: boolean;
  rpcThrow?: boolean;
  rpcData?: number | null;
  insert?: { error: { code?: string; message: string } | null };
  insertThrow?: boolean;
}): LedgerClient {
  return {
    rpc: async () => {
      if (opts.rpcThrow) throw new Error('network');
      if (opts.rpcError || opts.rpcData === undefined) {
        return { data: null, error: { message: 'schema cache' } };
      }
      return { data: opts.rpcData, error: null };
    },
    from: () => ({
      insert: async () => {
        if (opts.insertThrow) throw new Error('network');
        return opts.insert ?? { error: null };
      },
    }),
  };
}

describe('bidder credit buckets flag and ledger helpers', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['yes', false],
    ['on', false],
    ['true', true],
    ['TRUE', true],
    [' 1 ', true],
  ])('flag %j → %s', (raw, expected) => {
    expect(isBidderCreditBucketsEnabled(raw === undefined ? off : { [BIDDER_CREDIT_BUCKETS_ENV]: raw })).toBe(
      expected,
    );
  });

  it('flag off: 10000 invoice, 3000 spend, card 7000 on first attempt and decline retry', async () => {
    expect(isBidderCreditBucketsEnabled(off)).toBe(false);
    expect(REVERSE_CREDIT_ON_RECOVERABLE_DECLINE).toBe(false);
    const spend = {
      bidderId: BIDDER,
      invoiceId: INVOICE,
      reason: 'spend',
      amountCents: -3000,
    };
    const first = ledgerInsertGate(spend, false);
    expect(first).toEqual({
      ok: true,
      payload: { bidder_id: BIDDER, amount_cents: -3000, reason: 'spend', invoice_id: INVOICE },
    });
    expect(cardRemainderCents(10000, 3000)).toBe(7000);
    const retry = await insertBidderCreditRow(client({ insert: { error: { code: '23505', message: 'dup' } } }), spend, off);
    expect(retry).toEqual({ ok: true, status: 'already' });
    expect(uniqueViolationAlreadyDone('23505')).toBe(true);
    expect(cardRemainderCents(10000, 3000)).toBe(7000);
  });

  it('disabled: no new reasons, no cash-bucket/split writes', async () => {
    expect(ledgerInsertGate({ bidderId: BIDDER, amountCents: 2000, reason: 'wallet_load', bucket: 'cash' }, false)).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(
      ledgerInsertGate(
        { bidderId: BIDDER, invoiceId: INVOICE, reason: 'spend', amountCents: -5000, spendCreditCents: 3000, spendCashCents: 2000 },
        false,
      ),
    ).toEqual({ ok: false, reason: 'disabled' });
    expect(await readBucketBalanceCents(client({ rpcData: 0 }), { bidderId: BIDDER, bucket: 'cash' }, off)).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(authorizeBucketAccess({ enabled: false, actorBidderId: BIDDER, targetBidderId: BIDDER })).toBe('disabled');
  });

  it('denied: business cash, cross-owner, split mismatch', () => {
    expect(authorizeBucketAccess({ enabled: true, actorBidderId: BIDDER, targetBidderId: OTHER })).toBe('denied');
    expect(
      authorizeBucketAccess({
        enabled: true,
        actorBidderId: BIDDER,
        targetBidderId: BIDDER,
        ownerKind: 'business',
        bucket: 'cash',
      }),
    ).toBe('denied');
    expect(
      ledgerInsertGate({ bidderId: BIDDER, amountCents: 100, reason: 'wallet_load', ownerKind: 'business', bucket: 'cash' }, true),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(
      ledgerInsertGate(
        { bidderId: BIDDER, invoiceId: INVOICE, reason: 'spend', amountCents: -100, spendCreditCents: 30, spendCashCents: 20 },
        true,
      ),
    ).toEqual({ ok: false, reason: 'denied' });
  });

  it('enabled: one spend payload with additive split columns', () => {
    const gated = ledgerInsertGate(
      {
        bidderId: BIDDER,
        invoiceId: INVOICE,
        reason: 'spend',
        amountCents: -5000,
        spendCreditCents: 3000,
        spendCashCents: 2000,
      },
      true,
    );
    expect(gated).toEqual({
      ok: true,
      payload: {
        bidder_id: BIDDER,
        amount_cents: -5000,
        reason: 'spend',
        invoice_id: INVOICE,
        bucket: null,
        spend_credit_cents: 3000,
        spend_cash_cents: 2000,
      },
    });
  });

  it('retry 23505 is already-done; other insert errors are dependency-missing', async () => {
    expect(await insertBidderCreditRow(client({}), { bidderId: BIDDER, amountCents: 1, reason: 'manual' }, off)).toEqual({
      ok: true,
      status: 'inserted',
    });
    expect(
      await insertBidderCreditRow(
        client({ insert: { error: { code: '23505', message: 'dup' } } }),
        { bidderId: BIDDER, invoiceId: INVOICE, reason: 'spend', amountCents: -1 },
        off,
      ),
    ).toEqual({ ok: true, status: 'already' });
    expect(
      await insertBidderCreditRow(client({ insert: { error: { code: '57014', message: 'timeout' } } }), {
        bidderId: BIDDER,
        amountCents: 1,
        reason: 'manual',
      }, off),
    ).toEqual({ ok: false, reason: 'dependency_missing' });
  });

  it('dependency-missing: rpc missing, throw, or non-integer', async () => {
    expect(await readBucketBalanceCents(client({ rpcError: true }), { bidderId: BIDDER, bucket: 'credit' }, on)).toEqual({
      ok: false,
      reason: 'dependency_missing',
    });
    expect(await readBucketBalanceCents(client({ rpcThrow: true }), { bidderId: BIDDER, bucket: 'credit' }, on)).toEqual({
      ok: false,
      reason: 'dependency_missing',
    });
    expect(await readBucketBalanceCents(client({ rpcData: 6000 }), { bidderId: BIDDER, bucket: 'credit' }, on)).toEqual({
      ok: true,
      cents: 6000,
    });
  });

  it('wallet loads are not revenue', () => {
    expect(WALLET_LOAD_REVENUE_SOURCES).toEqual([]);
    expect([...GROWTH_REVENUE_SOURCES]).not.toContain('wallet_load');
  });
});
