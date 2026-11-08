import { stickerLabel } from '@auction-platform/shared';

type LotCodeShape = {
  lot_code: string | null;
  sticker_code: string | null;
  display_code?: string | null;
  lot_id?: string | null;
};

type AlternateCodeShape = {
  upc?: string | null;
  lpn?: string | null;
  tracking_number?: string | null;
};

function resolveCheckoutSticker(lot: LotCodeShape): string | null {
  const displayTrimmed = lot.display_code?.trim();
  if (displayTrimmed) {
    const lotCode = lot.lot_code?.trim() ?? '';
    if (lotCode.toLowerCase() !== displayTrimmed.toLowerCase()) {
      return displayTrimmed;
    }
  }
  return stickerLabel(lot.sticker_code);
}

export function checkoutLotLabel(lot: {
  lot_code: string | null;
  sticker_code: string | null;
  display_code?: string | null;
  lot_id?: string;
}): { primary: string; secondary: string | null; noSticker: boolean } {
  const sticker = resolveCheckoutSticker(lot);
  if (sticker) {
    const secondary =
      lot.lot_code && lot.lot_code.toLowerCase() !== sticker.toLowerCase() ? lot.lot_code : null;
    return { primary: sticker, secondary, noSticker: false };
  }
  const primary = lot.lot_code ?? lot.lot_id?.slice(0, 8) ?? '—';
  return { primary, secondary: null, noSticker: true };
}

function stickerMatchNeedles(lot: LotCodeShape): string[] {
  const needles: string[] = [];
  const displayTrimmed = lot.display_code?.trim();
  if (displayTrimmed) {
    const lotCode = lot.lot_code?.trim() ?? '';
    if (lotCode.toLowerCase() !== displayTrimmed.toLowerCase()) {
      needles.push(displayTrimmed.toLowerCase());
    }
  }
  const stripped = stickerLabel(lot.sticker_code);
  if (stripped) needles.push(stripped.toLowerCase());
  if (lot.sticker_code) needles.push(lot.sticker_code.trim().toLowerCase());
  return needles;
}

export type CheckoutLotMatch =
  | { kind: 'none' }
  | { kind: 'unique'; index: number }
  | { kind: 'ambiguous'; indices: number[] };

/**
 * Resolve one scanned or typed code against the invoice lines on screen.
 *
 * #813: the old version returned the FIRST matching line, so a code that
 * matched two boxes (case-distinct stickers, or a canonical lot_code colliding
 * with another line's sticker) silently picked one. The screen then submitted
 * that line's canonical lot_code — the raw ambiguous code never reached
 * `staff_confirm_pickup`, so the server-side ambiguity guard could not help.
 *
 * Every alias on every line is now compared and a code that matches more than
 * one distinct lot is reported as `ambiguous`; callers must refuse it instead
 * of checking a box off. Two aliases that resolve to the SAME lot (its own
 * lot_code and sticker, or a lot listed twice in a combined checkout) stay a
 * single unique match.
 */
export function matchCheckoutLot<T extends LotCodeShape>(lots: T[], raw: string): CheckoutLotMatch {
  const needle = raw.trim().toLowerCase();
  if (!needle) return { kind: 'none' };

  const indices: number[] = [];
  const seenLots = new Set<string>();
  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    if (lot === undefined) continue;
    const matches =
      stickerMatchNeedles(lot).some((n) => n.trim().toLowerCase() === needle) ||
      (lot.lot_code != null && lot.lot_code.trim().toLowerCase() === needle);
    if (!matches) continue;

    // Combined checkout can list the same lot on more than one order. That is
    // one physical box, not an ambiguity.
    const identity = lot.lot_id?.trim();
    if (identity) {
      if (seenLots.has(identity)) continue;
      seenLots.add(identity);
    }
    indices.push(i);
  }

  if (indices.length === 0) return { kind: 'none' };
  if (indices.length === 1) return { kind: 'unique', index: indices[0] as number };
  return { kind: 'ambiguous', indices };
}

/**
 * Resolve an expanded physical barcode (product UPC, Amazon LPN, FedEx
 * return-tracking, or the 12-digit suffix of a composite label) against the
 * invoice lines on screen.
 *
 * #816: the old screen code used `findIndex`, so two lots sharing a UPC/LPN/
 * tracking still selected whichever row happened to be first and submitted it.
 * Like `matchCheckoutLot`, this now reports `ambiguous` and callers must refuse
 * before checking a line off.
 */
export function matchAlternateBarcode<T extends AlternateCodeShape & { lot_id?: string | null }>(
  lots: T[],
  candidates: string[],
): CheckoutLotMatch {
  const needles = candidates.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return { kind: 'none' };

  const indices: number[] = [];
  const seenLots = new Set<string>();
  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    if (lot === undefined) continue;
    const aliases = [lot.upc, lot.lpn, lot.tracking_number]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim().toLowerCase());
    if (aliases.length === 0) continue;
    if (!needles.some((needle) => aliases.includes(needle))) continue;

    // Combined checkout can list the same lot on more than one order: one
    // physical box, not two matches.
    const identity = lot.lot_id?.trim();
    if (identity) {
      if (seenLots.has(identity)) continue;
      seenLots.add(identity);
    }
    indices.push(i);
  }

  if (indices.length === 0) return { kind: 'none' };
  if (indices.length === 1) return { kind: 'unique', index: indices[0] as number };
  return { kind: 'ambiguous', indices };
}

export type CheckoutScanLot = LotCodeShape & AlternateCodeShape & { lot_id?: string | null };

export type CheckoutScanResolution =
  | { kind: 'none' }
  | { kind: 'unique'; index: number }
  | {
      kind: 'ambiguous';
      indices: number[];
      reason: 'direct' | 'alternate' | 'cross_namespace';
    };

function samePhysicalLot(
  a: CheckoutScanLot | undefined,
  b: CheckoutScanLot | undefined,
): boolean {
  if (!a || !b) return false;
  const idA = a.lot_id?.trim();
  const idB = b.lot_id?.trim();
  if (idA && idB) return idA === idB;
  return a === b;
}

/**
 * Resolve one scanned/typed code against every namespace on the screen.
 *
 * #819: the scan handler used to try the direct lot_code/sticker namespace and
 * only fall back to UPC/LPN/tracking when the direct match found nothing. A
 * single scan that named one box's sticker and a different box's LPN therefore
 * selected the first box without ever noticing the collision. This resolves
 * both namespaces together and refuses when they name different boxes.
 *
 * The direct namespace is matched from the raw scanned string; the alternate
 * namespace from the extracted candidates (raw value, composite suffix, long
 * digit runs). A lot listed twice on a combined order stays one physical box.
 */
export function resolveCheckoutScan<T extends CheckoutScanLot>(
  lots: T[],
  scanData: string,
  candidates: string[],
): CheckoutScanResolution {
  const direct = matchCheckoutLot(lots, scanData);
  const alternate = matchAlternateBarcode(lots, candidates);

  if (direct.kind === 'ambiguous') {
    return { kind: 'ambiguous', indices: direct.indices, reason: 'direct' };
  }
  if (alternate.kind === 'ambiguous') {
    return { kind: 'ambiguous', indices: alternate.indices, reason: 'alternate' };
  }
  if (direct.kind === 'unique') {
    if (alternate.kind === 'unique' && !samePhysicalLot(lots[direct.index], lots[alternate.index])) {
      return {
        kind: 'ambiguous',
        indices: [direct.index, alternate.index],
        reason: 'cross_namespace',
      };
    }
    return { kind: 'unique', index: direct.index };
  }
  if (alternate.kind === 'unique') return { kind: 'unique', index: alternate.index };
  return { kind: 'none' };
}

export type ConfirmUniverseLot = LotCodeShape & {
  invoice_id: string;
  lot_id?: string | null;
  checked?: boolean;
};

export type CheckedLotState = { lot_id: string; invoice_id: string; checked: boolean };

/**
 * Build the `planConfirmCodes` input from the complete invoice alias universe.
 *
 * #819: the screen only carries OWED lines (`lotStates`), so a checked line's
 * canonical code could collide with a hidden sibling's sticker and never be
 * seen by `chooseConfirmCode`. The alias universe includes every invoice line —
 * refunded, picked-up and forfeited siblings included — while `checked` is
 * copied from the live checklist so only owed, checked lines are submitted.
 */
export function buildConfirmUniverse<T extends ConfirmUniverseLot, S extends CheckedLotState>(
  aliasLots: T[],
  states: S[],
): Array<T & { checked: boolean }> {
  const checked = new Set<string>();
  for (const state of states) {
    if (state.checked) checked.add(`${state.invoice_id}\u0000${state.lot_id}`);
  }
  return aliasLots.map((lot) => ({
    ...lot,
    checked: lot.lot_id ? checked.has(`${lot.invoice_id}\u0000${lot.lot_id}`) : false,
  }));
}

/**
 * The codes `staff_confirm_pickup` resolves against (0304 / 0487 / 0509):
 * `lot_code` or the raw half of `sticker_code` (the part after "{op}:").
 * UPC/LPN/tracking/display_code are client-only aliases and are NOT sent.
 */
function serverPickupAliases(lot: LotCodeShape): string[] {
  const aliases: string[] = [];
  const lotCode = lot.lot_code?.trim();
  if (lotCode) aliases.push(lotCode.toLowerCase());
  const label = stickerLabel(lot.sticker_code)?.toLowerCase();
  if (label) aliases.push(label);
  return aliases;
}

function serverResolvesTo<T extends LotCodeShape>(lots: T[], code: string): number[] {
  const needle = code.trim().toLowerCase();
  if (!needle) return [];
  const indices: number[] = [];
  const seenLots = new Set<string>();
  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    if (lot === undefined) continue;
    if (!serverPickupAliases(lot).includes(needle)) continue;
    const identity = lot.lot_id?.trim();
    if (identity) {
      if (seenLots.has(identity)) continue;
      seenLots.add(identity);
    }
    indices.push(i);
  }
  return indices;
}

/**
 * Choose a submitted code for one checked line that the server resolves to
 * exactly that line and no other.
 *
 * #816: the screen sent the canonical `lot_code` for every checked lot. If a
 * raw alias was scanned uniquely but that canonical code collides with another
 * line's sticker (or vice versa), 0487 stamped `LIMIT 1` (possibly the wrong
 * box) and 0509 refused the whole round. Prefer the canonical code; fall back
 * to the line's sticker label only when the canonical code is ambiguous.
 */
export function chooseConfirmCode<T extends LotCodeShape>(lots: T[], index: number): string | null {
  const lot = lots[index];
  if (lot === undefined) return null;

  const candidates: string[] = [];
  const lotCode = lot.lot_code?.trim();
  if (lotCode) candidates.push(lotCode);
  const label = stickerLabel(lot.sticker_code);
  if (label) candidates.push(label);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const resolved = serverResolvesTo(lots, candidate);
    if (resolved.length === 1 && resolved[0] === index) return candidate;
  }
  return null;
}

export type ConfirmCodePlan = {
  ok: boolean;
  codesByInvoice: Record<string, string[]>;
  blocked: Array<{ invoice_id: string; lot_code: string | null; sticker_code: string | null }>;
};

/**
 * Build the per-invoice `p_lot_codes` payload for `staff_confirm_pickup`.
 *
 * Only checked lines are included (partial consent keeps siblings owed), and
 * each line's code is chosen against every line on its OWN invoice so a code
 * can never resolve to a sibling. When no alias is unique the plan is not
 * submittable: the caller must abort rather than hand the server a code that
 * could stamp the wrong box.
 */
export function planConfirmCodes<T extends LotCodeShape & { invoice_id: string; checked: boolean }>(
  lots: T[],
): ConfirmCodePlan {
  const byInvoice = new Map<string, T[]>();
  for (const lot of lots) {
    const arr = byInvoice.get(lot.invoice_id) ?? [];
    arr.push(lot);
    byInvoice.set(lot.invoice_id, arr);
  }

  const codesByInvoice: Record<string, string[]> = {};
  const blocked: ConfirmCodePlan['blocked'] = [];

  for (const [invoiceId, invoiceLots] of byInvoice) {
    const codes: string[] = [];
    for (let i = 0; i < invoiceLots.length; i++) {
      const lot = invoiceLots[i];
      if (lot === undefined || !lot.checked || !lot.lot_code) continue;
      const code = chooseConfirmCode(invoiceLots, i);
      if (code === null) {
        blocked.push({
          invoice_id: invoiceId,
          lot_code: lot.lot_code,
          sticker_code: lot.sticker_code,
        });
        continue;
      }
      codes.push(code);
    }
    codesByInvoice[invoiceId] = codes;
  }

  return { ok: blocked.length === 0, codesByInvoice, blocked };
}
