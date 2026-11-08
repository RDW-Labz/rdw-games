import { describe, expect, it } from 'vitest';
import { refundedRelotTarget } from './refunded-relot';

describe('refundedRelotTarget', () => {
  it('opens the refunded relot form for a refunded lot with no child', () => {
    expect(
      refundedRelotTarget({ status: 'refunded', lotCode: 'TEA3828564', relotChildCode: null }),
    ).toEqual({ pathname: '/lotting/relot', params: { code: 'TEA3828564' } });
  });

  it('does not offer the form again once the item has a relist child', () => {
    expect(
      refundedRelotTarget({
        status: 'refunded',
        lotCode: 'TEA3828564',
        relotChildCode: 'TEA3829001',
      }),
    ).toBeNull();
  });

  it('leaves other statuses on their existing relot paths', () => {
    for (const status of ['won', 'unsold', 'in_inventory', 'relisted', 'draft', 'canceled']) {
      expect(
        refundedRelotTarget({ status, lotCode: 'BIN-000001', relotChildCode: null }),
      ).toBeNull();
    }
  });
});
