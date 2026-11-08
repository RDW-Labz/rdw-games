import { describe, it, expect } from 'vitest';
import { resolveLotIdentity } from '../lot-identity';

describe('resolveLotIdentity', () => {
  it('shows stripped sticker as primary with BIN secondary', () => {
    expect(
      resolveLotIdentity({
        lot_code: 'BIN-029098',
        sticker_code: 'BIN:BRN4982227',
        display_code: null,
      }),
    ).toEqual({
      primary: 'BRN4982227',
      secondary: 'BIN-029098',
      noSticker: false,
      unavailable: false,
    });
  });

  it('treats display_code equal to lot_code as no sticker', () => {
    expect(
      resolveLotIdentity({
        lot_code: 'BIN-029098',
        sticker_code: 'BIN:BRN4982227',
        display_code: 'BIN-029098',
      }),
    ).toEqual({
      primary: 'BIN-029098',
      secondary: null,
      noSticker: true,
      unavailable: false,
    });
  });

  it('uses lot_code primary when no sticker', () => {
    expect(
      resolveLotIdentity({
        lot_code: 'BIN-031005',
        sticker_code: null,
        display_code: null,
      }),
    ).toEqual({
      primary: 'BIN-031005',
      secondary: null,
      noSticker: true,
      unavailable: false,
    });
  });
});
