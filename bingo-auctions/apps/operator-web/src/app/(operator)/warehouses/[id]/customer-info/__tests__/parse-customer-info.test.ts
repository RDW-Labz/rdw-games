import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTICE_MAX,
  PICKUP_INSTRUCTIONS_MAX,
  parseCustomerInfoInput,
} from '../parse-customer-info';

describe('parseCustomerInfoInput', () => {
  it('trims strings and saves empty as null', () => {
    const result = parseCustomerInfoInput({
      pickupInstructions: '  Ring the bell  ',
      customerNotice: '   ',
      active: true,
    });
    expect(result).toEqual({
      ok: true,
      data: {
        pickup_instructions: 'Ring the bell',
        customer_notice: null,
        active: true,
      },
    });
  });

  it('rejects over-length pickup instructions', () => {
    const result = parseCustomerInfoInput({
      pickupInstructions: 'x'.repeat(PICKUP_INSTRUCTIONS_MAX + 1),
      customerNotice: '',
      active: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(String(PICKUP_INSTRUCTIONS_MAX));
    }
  });

  it('rejects over-length customer notice', () => {
    const result = parseCustomerInfoInput({
      pickupInstructions: '',
      customerNotice: 'y'.repeat(CUSTOMER_NOTICE_MAX + 1),
      active: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(String(CUSTOMER_NOTICE_MAX));
    }
  });
});
