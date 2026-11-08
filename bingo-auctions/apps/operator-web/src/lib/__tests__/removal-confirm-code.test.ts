import { describe, it, expect } from 'vitest';
import { removalConfirmCode, confirmCodeMatches } from '@/lib/removal-confirm-code';

describe('removalConfirmCode', () => {
  it('uses stripped sticker when sticker_code differs from lot_code', () => {
    expect(
      removalConfirmCode({
        lot_code: 'BIN-029098',
        sticker_code: 'BIN:BRN4982227',
        display_code: null,
      }),
    ).toEqual({
      confirmCode: 'BRN4982227',
      secondary: 'BIN-029098',
      noSticker: false,
    });
  });

  it('uses display_code as confirmCode when it differs from lot_code', () => {
    expect(
      removalConfirmCode({
        lot_code: 'BIN-029098',
        sticker_code: null,
        display_code: 'BRN1234567',
      }),
    ).toEqual({
      confirmCode: 'BRN1234567',
      secondary: 'BIN-029098',
      noSticker: false,
    });
  });

  it('falls back to lot_code when there is no sticker', () => {
    expect(
      removalConfirmCode({
        lot_code: 'BIN-031005',
        sticker_code: null,
        display_code: null,
      }),
    ).toEqual({
      confirmCode: 'BIN-031005',
      secondary: null,
      noSticker: true,
    });
  });

  it('treats display_code equal to lot_code as no sticker', () => {
    expect(
      removalConfirmCode({
        lot_code: 'BIN-029098',
        sticker_code: 'BIN:BRN4982227',
        display_code: 'BIN-029098',
      }),
    ).toEqual({
      confirmCode: 'BIN-029098',
      secondary: null,
      noSticker: true,
    });
  });

  it('uses lot_number when lot_code is missing and there is no sticker', () => {
    expect(
      removalConfirmCode({
        lot_code: null,
        sticker_code: null,
        display_code: null,
        lot_number: 123,
      }),
    ).toEqual({
      confirmCode: '#123',
      secondary: null,
      noSticker: true,
    });
  });
});

describe('confirmCodeMatches', () => {
  const sticker = 'BRN4982227';

  it('accepts exact, lowercase, and surrounding spaces', () => {
    expect(confirmCodeMatches('BRN4982227', sticker)).toBe(true);
    expect(confirmCodeMatches('brn4982227', sticker)).toBe(true);
    expect(confirmCodeMatches('  BRN4982227  ', sticker)).toBe(true);
  });

  it('rejects BIN lot code when sticker is required', () => {
    expect(confirmCodeMatches('BIN-029098', sticker)).toBe(false);
  });

  it('rejects empty input', () => {
    expect(confirmCodeMatches('', sticker)).toBe(false);
    expect(confirmCodeMatches('   ', sticker)).toBe(false);
  });
});
