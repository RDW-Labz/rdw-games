import { describe, it, expect } from 'vitest';
import { pickupOverrideOffer } from '../pickup-override-offer';

const base = { owed: false, kind: 'forfeited', invoicePaid: true, lotStatus: 'unsold', hasRelistChild: false };

describe('pickupOverrideOffer', () => {
  it('offers an owed line exactly as before', () => {
    expect(pickupOverrideOffer({ ...base, owed: true, kind: 'owed', lotStatus: 'won' })).toBe('owed');
    expect(pickupOverrideOffer({ ...base, owed: true, kind: 'missing' })).toBe('owed');
  });

  it('GRA4123327: paid, forfeited, lot still unsold, never relisted → offered', () => {
    expect(pickupOverrideOffer(base)).toBe('forfeited_not_resold');
  });

  it('never offers a forfeited line whose lot has a relist child (resold, or a person acted on it)', () => {
    expect(pickupOverrideOffer({ ...base, hasRelistChild: true })).toBeNull();
    expect(pickupOverrideOffer({ ...base, lotStatus: 'relisted', hasRelistChild: true })).toBeNull();
  });

  it('never offers a forfeited line whose lot is back on a shelf or elsewhere', () => {
    for (const lotStatus of ['in_inventory', 'relisted', 'scheduled', 'live', 'won', null]) {
      expect(pickupOverrideOffer({ ...base, lotStatus })).toBeNull();
    }
  });

  it('never offers an unpaid invoice, a refunded line, a picked-up line, or a relisted line', () => {
    expect(pickupOverrideOffer({ ...base, invoicePaid: false })).toBeNull();
    for (const kind of ['refunded', 'picked_up', 'relisted', 'not_paid']) {
      expect(pickupOverrideOffer({ ...base, kind })).toBeNull();
    }
  });
});
