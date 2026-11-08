// #849: the counter confirms a Missing tap against the lot's current bin.
// The note stays optional (the floor must not slow down) but a quick reason
// is offered so an empty note is not the only possible record. The bidder
// fallback text ("Not found at pickup") is never used as a reason here.

/** Server-side maximum for the stored Missing note (see `actions.ts`). */
export const MISSING_NOTE_MAX = 500;

/** Keeps the quick reason and the typed note visually distinct in one column. */
export const MISSING_NOTE_SEPARATOR = ' — ';

export const MISSING_QUICK_REASONS = [
  'Not in the bin',
  'Not on the shelf',
  'Wrong bin label',
] as const;

export type MissingQuickReason = (typeof MISSING_QUICK_REASONS)[number];

export function missingLocationText(
  binCode: string | null,
  warehouseName: string | null,
): { text: string; hasBin: boolean } {
  if (binCode) {
    return {
      text: warehouseName ? `${binCode} · ${warehouseName}` : binCode,
      hasBin: true,
    };
  }
  return { text: 'No bin recorded — last location was cleared.', hasBin: false };
}

/** Blank means "no reason": never substitute an inferred or fallback label. */
export function composeMissingNote(reason: string | null, note: string): string | null {
  const trimmed = note.trim();
  if (reason && trimmed) return `${reason}${MISSING_NOTE_SEPARATOR}${trimmed}`;
  if (reason) return reason;
  return trimmed || null;
}

/**
 * How many typed characters fit beside the currently selected reason. The
 * separator and the reason are part of the stored note, so the input must be
 * capped by the remainder — not by `MISSING_NOTE_MAX` alone.
 */
export function missingNoteBudget(reason: string | null): number {
  if (!reason) return MISSING_NOTE_MAX;
  return Math.max(0, MISSING_NOTE_MAX - reason.length - MISSING_NOTE_SEPARATOR.length);
}

export type MissingNoteValidation =
  | { ok: true; note: string | null; budget: number }
  | { ok: false; error: string; budget: number };

/**
 * Parses the composed value with the server's schema before it is submitted.
 * Over-budget text is reported, never silently truncated.
 */
export function validateMissingNote(reason: string | null, note: string): MissingNoteValidation {
  const budget = missingNoteBudget(reason);
  const composed = composeMissingNote(reason, note);
  const length = composed?.length ?? 0;
  if (length > MISSING_NOTE_MAX) {
    return {
      ok: false,
      budget,
      error: reason
        ? `The note is ${length} characters. Shorten it to ${budget} to keep "${reason}".`
        : `The note is ${length} characters. The limit is ${MISSING_NOTE_MAX}.`,
    };
  }
  return { ok: true, note: composed, budget };
}
