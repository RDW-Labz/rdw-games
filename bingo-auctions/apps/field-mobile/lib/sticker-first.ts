// Pre-stickered mode: decide BEFORE a lot is saved whether the sticker is
// already known or must be scanned first.
//
// Until 2026-10-05 every lotting screen saved the lot and then opened the
// sticker scanner. A save with no sticker was therefore always possible: a
// killed app, a dismissed modal or a manager's skip left a lot that no label
// resolves at put-away. The owner's rule now: in Pre-stickered mode, no sticker
// scanned means no save. This module is the one place that rule lives, so the
// four screens (Quick Lot, Photo, Manual, Web) agree and it is unit-tested.

export type StickerPlan =
  /** Save now. `sticker` is bound right after the save; null = Generate mode. */
  | { action: 'save'; sticker: string | null }
  /** Open the capture scanner first; call again with `capturedSticker`. */
  | { action: 'scan_first' };

export interface StickerPlanInput {
  /** 'generate' | 'prestickered' | 'lpn_sticker' (LottingMode). */
  mode: string;
  /** Quick Lot: the code the camera just read. Other screens: undefined. */
  scannedCode?: string | null;
  /** Quick Lot: the scan matched a Wayfair manifest row, so the code is a
   *  shipping label, not the lot's sticker. */
  isManifestMatch?: boolean;
  /** Manual: a sticker handed over from Quick Lot's no-match path. */
  prefilledSticker?: string | null;
  /** The value the capture scanner returned on this screen. '' means a
   *  manager chose to save without one (the post-save scanner still opens). */
  capturedSticker?: string | null;
  /** Quick Lot's test for "this scan is the physical label, not a UPC". */
  looksLikePhysicalSticker?: (code: string) => boolean;
}

export function planStickerBeforeSave(input: StickerPlanInput): StickerPlan {
  if (input.mode === 'generate') return { action: 'save', sticker: null };
  if (input.capturedSticker !== undefined && input.capturedSticker !== null) {
    const c = input.capturedSticker.trim();
    return { action: 'save', sticker: c || null };
  }
  const prefilled = (input.prefilledSticker ?? '').trim();
  if (prefilled) return { action: 'save', sticker: prefilled };
  const code = (input.scannedCode ?? '').trim();
  if (
    code &&
    !input.isManifestMatch &&
    (input.looksLikePhysicalSticker ? input.looksLikePhysicalSticker(code) : false)
  ) {
    return { action: 'save', sticker: code };
  }
  return { action: 'scan_first' };
}

/** Copy for the alert when the operator backs out of the capture scanner. */
export const NO_STICKER_SCANNED_TITLE = 'No sticker scanned';
export const NO_STICKER_SCANNED_MESSAGE =
  'The lot was not saved. In Pre-stickered mode, scan the sticker on the box first, then save.';
