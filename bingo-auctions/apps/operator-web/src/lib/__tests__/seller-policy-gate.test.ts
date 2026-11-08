// Guards for the website seller-policy gate (lot page BidWidget).
//
// The bidder app has made a bidder accept an operator's latest published
// policy before bidding since mig 0088; the website called place_bid with no
// gate at all. The negative case below is that gap: a published policy the
// bidder has not accepted must NOT let the bid through. Verified failing
// first against a stub that always answered 'no_policy' (the old behaviour).

import { describe, expect, it } from 'vitest';
import { decideSellerPolicyGate, type SellerPolicyRef } from '../seller-policy-gate';

const V2: SellerPolicyRef = { operator_id: 'op-1', version: 2 };

describe('decideSellerPolicyGate', () => {
  it('gates a bidder who has not accepted the latest published version', () => {
    // THE NEGATIVE CASE — the website used to bid straight through this.
    expect(
      decideSellerPolicyGate({ policy: V2, policyLookupFailed: false, acceptanceCount: 0 }),
    ).toBe('needs_acceptance');
  });

  it('lets a bidder through once that exact version is accepted', () => {
    expect(
      decideSellerPolicyGate({ policy: V2, policyLookupFailed: false, acceptanceCount: 1 }),
    ).toBe('accepted');
  });

  it('does not gate when the operator has no published policy (same as the app)', () => {
    expect(
      decideSellerPolicyGate({ policy: null, policyLookupFailed: false, acceptanceCount: null }),
    ).toBe('no_policy');
  });

  it('asks again when the acceptance lookup gave no answer', () => {
    // A failed count is not proof of acceptance. Re-accepting only writes
    // another acceptance row, so asking is the safe side.
    expect(
      decideSellerPolicyGate({ policy: V2, policyLookupFailed: false, acceptanceCount: null }),
    ).toBe('needs_acceptance');
  });

  it('does not treat a failed policy lookup as "no policy"', () => {
    // A network error must not quietly open the no-gate path.
    expect(
      decideSellerPolicyGate({ policy: null, policyLookupFailed: true, acceptanceCount: null }),
    ).toBe('lookup_failed');
  });
});
