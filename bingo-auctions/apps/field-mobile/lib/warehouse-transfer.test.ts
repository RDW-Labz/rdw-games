import { describe, expect, it } from 'vitest';
import {
  binLookupWarehouseId,
  transferDoneLine,
  transferInputsReady,
  transferMessage,
  transferReasonChoices,
  transferReasonText,
  OTHER_REASON,
} from './warehouse-transfer';

describe('warehouse transfer on put-away (mig 0473)', () => {
  it('needs a typed name and a reason; blanks do not count', () => {
    expect(transferInputsReady('Tim', 'Truck from Crandall')).toBe(true);
    expect(transferInputsReady('  ', 'Truck')).toBe(false);
    expect(transferInputsReady('Tim', '   ')).toBe(false);
  });

  it('typed bin codes: a transfer looks HERE, a normal put-away in the lot building', () => {
    expect(binLookupWarehouseId(true, 'crandall', 'harrison')).toBe('harrison');
    expect(binLookupWarehouseId(false, 'crandall', 'harrison')).toBe('crandall');
    expect(binLookupWarehouseId(false, null, 'harrison')).toBe('harrison');
    expect(binLookupWarehouseId(true, 'crandall', null)).toBe('crandall');
  });

  it('every server refusal has plain words; unknown ones still show', () => {
    for (const r of ['in_sale', 'sold', 'open_invoice', 'staged_for_pickup', 'in_open_auction', 'not_in_stock', 'relot_refused']) {
      expect(transferMessage(r)).not.toMatch(/^Server:/);
    }
    expect(transferMessage('something_new')).toBe('Server: something_new');
  });

  it('done line names both buildings and the shelf', () => {
    expect(transferDoneLine({ ok: true, reason: 'ok_transferred', from_warehouse: 'Crandall', to_warehouse: 'Harrison', bin_code: '5-01-01' }))
      .toBe('Transferred from Crandall to Harrison → bin 5-01-01');
  });

  it('reason is a one-tap pick; "Other" needs typed text', () => {
    const choices = transferReasonChoices('Crandall');
    expect(choices[0]).toBe('Came on the truck from Crandall');
    expect(choices).toContain(OTHER_REASON);
    expect(transferReasonText(choices[0] ?? null, '')).toBe('Came on the truck from Crandall');
    expect(transferReasonText(OTHER_REASON, '  ')).toBe('');
    expect(transferReasonText(OTHER_REASON, ' Wrong truck ')).toBe('Wrong truck');
    expect(transferReasonText(null, 'x')).toBe('');
    expect(transferInputsReady('Tim', transferReasonText(OTHER_REASON, ''))).toBe(false);
  });
});
