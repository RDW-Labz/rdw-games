import { describe, expect, it } from 'vitest';
import { decideOffsiteNoticeGate } from '../offsite-notice-gate';

const OFFSITE = {
  isOffsite: true,
  name: 'Temp',
  addressLines: ['1 St'],
  fullAddress: '1 St',
  directionsUrl: null,
  hoursLines: [],
  instructions: null,
  notice: 'Read this.',
};

const ONSITE = {
  isOffsite: false,
  name: 'Main',
  addressLines: [],
  fullAddress: null,
  directionsUrl: null,
  hoursLines: [],
  instructions: null,
  notice: null,
};

describe('decideOffsiteNoticeGate', () => {
  it('does not gate when there is no off-site notice', () => {
    expect(
      decideOffsiteNoticeGate({ pickup: ONSITE, pickupLookupFailed: false, hasAcked: false }),
    ).toBe('no_notice');
  });

  it('gates when notice exists and the bidder has not acked', () => {
    expect(
      decideOffsiteNoticeGate({ pickup: OFFSITE, pickupLookupFailed: false, hasAcked: false }),
    ).toBe('needs_ack');
  });

  it('does not gate once the current notice text is acked', () => {
    expect(
      decideOffsiteNoticeGate({ pickup: OFFSITE, pickupLookupFailed: false, hasAcked: true }),
    ).toBe('acked');
  });

  it('fails open when pickup lookup failed', () => {
    expect(
      decideOffsiteNoticeGate({ pickup: null, pickupLookupFailed: true, hasAcked: null }),
    ).toBe('lookup_failed');
  });

  it('fails open when has_acked lookup failed', () => {
    expect(
      decideOffsiteNoticeGate({ pickup: OFFSITE, pickupLookupFailed: false, hasAcked: null }),
    ).toBe('lookup_failed');
  });
});
