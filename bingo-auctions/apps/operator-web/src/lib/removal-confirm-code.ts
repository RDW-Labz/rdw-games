import { lotDisplayCode } from '@auction-platform/shared';

export function removalConfirmCode(lot: {
  lot_code: string | null;
  sticker_code: string | null;
  display_code?: string | null;
  lot_number?: number | string | null;
}): { confirmCode: string; secondary: string | null; noSticker: boolean } {
  const lotCodeTrimmed = lot.lot_code?.trim() ?? '';
  const displayed = lotDisplayCode({
    lot_code: lot.lot_code,
    sticker_code: lot.sticker_code,
    display_code: lot.display_code,
  });
  const sticker = displayed?.trim() ?? '';

  const hasSticker =
    sticker !== '' &&
    (lotCodeTrimmed === '' || sticker.toLowerCase() !== lotCodeTrimmed.toLowerCase());

  if (hasSticker) {
    const secondary =
      lot.lot_code != null && lot.lot_code.trim() !== '' ? lot.lot_code.trim() : null;
    return { confirmCode: sticker, secondary, noSticker: false };
  }

  const confirmCode =
    lotCodeTrimmed !== ''
      ? lotCodeTrimmed
      : lot.lot_number != null && String(lot.lot_number).trim() !== ''
        ? `#${lot.lot_number}`
        : '—';

  return { confirmCode, secondary: null, noSticker: true };
}

export function confirmCodeMatches(typed: string, confirmCode: string): boolean {
  const t = typed.trim();
  if (!t) return false;
  return t.toLowerCase() === confirmCode.trim().toLowerCase();
}
