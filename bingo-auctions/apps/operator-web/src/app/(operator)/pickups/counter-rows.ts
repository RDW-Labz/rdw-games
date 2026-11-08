import { lotDisplayCode } from '@auction-platform/shared';

export type OwedLotLine = {
  lot_id: string;
  picked_up_at: string | null;
  refunded_at: string | null;
  lots: {
    lot_code: string | null;
    sticker_code: string | null;
    display_code: string | null;
  } | null;
};

export function customerLabel(
  b: { display_name: string | null; email: string | null } | undefined,
): string {
  const name = b?.display_name?.trim();
  if (name) return name;
  const email = b?.email?.trim();
  if (email) return email;
  return 'Name not on file';
}

export function invoiceShortId(id: string): string {
  return id.slice(0, 8);
}

export function owedLotCodes(
  lines: OwedLotLine[],
  missingLotIds: Set<string>,
): { code: string; secondary: string | null; noSticker: boolean }[] {
  const owed = lines.filter(
    (line) => !line.picked_up_at && !line.refunded_at && !missingLotIds.has(line.lot_id),
  );

  return owed
    .map((line) => {
      const lot = line.lots;
      if (!lot) {
        return { code: '—', secondary: null, noSticker: true, sortKey: '—' };
      }
      const display = lotDisplayCode(lot);
      const lotCode = lot.lot_code?.trim() || null;
      const displayNorm = display?.toLowerCase() ?? '';
      const lotCodeNorm = lotCode?.toLowerCase() ?? '';

      if (display && displayNorm !== lotCodeNorm) {
        return {
          code: display,
          secondary: lotCode,
          noSticker: false,
          sortKey: display.toLowerCase(),
        };
      }
      const code = lotCode ?? '—';
      return { code, secondary: null, noSticker: true, sortKey: code.toLowerCase() };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ code, secondary, noSticker }) => ({ code, secondary, noSticker }));
}
