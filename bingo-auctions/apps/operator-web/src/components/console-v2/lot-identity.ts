import { lotDisplayCode, type LotCodeFields } from '@auction-platform/shared';

export type LotIdentityInput = LotCodeFields & {
  lot_code?: string | null;
};

export type ResolvedLotIdentity = {
  primary: string;
  secondary: string | null;
  noSticker: boolean;
  unavailable: boolean;
};

/**
 * Sticker-first identity for console v2 primitives. Mirrors removal-confirm-code
 * sticker detection: display equal to lot_code means no physical sticker line.
 */
export function resolveLotIdentity(lot: LotIdentityInput): ResolvedLotIdentity {
  const lotCodeTrimmed = lot.lot_code?.trim() ?? '';
  const displayed = lotDisplayCode(lot);
  const sticker = displayed?.trim() ?? '';

  if (!sticker && !lotCodeTrimmed) {
    return {
      primary: 'Identifier unavailable',
      secondary: null,
      noSticker: true,
      unavailable: true,
    };
  }

  const hasSticker =
    sticker !== '' &&
    (lotCodeTrimmed === '' || sticker.toLowerCase() !== lotCodeTrimmed.toLowerCase());

  if (hasSticker) {
    const secondary =
      lot.lot_code != null && lot.lot_code.trim() !== '' ? lot.lot_code.trim() : null;
    return {
      primary: sticker,
      secondary,
      noSticker: false,
      unavailable: false,
    };
  }

  const primary = lotCodeTrimmed !== '' ? lotCodeTrimmed : sticker;
  return {
    primary,
    secondary: null,
    noSticker: true,
    unavailable: false,
  };
}
