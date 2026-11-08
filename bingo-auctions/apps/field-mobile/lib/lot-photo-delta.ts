import { supabase } from '@auction-platform/supabase-client';

export type PhotoDelta = {
  added: string[];
  removed: string[];
  /**
   * The desired order when the relative order of photos that survived changed.
   * Omitted when no reorder is needed, so a pure add/remove sends no extra RPC.
   */
  reorder?: string[];
};

/**
 * What changed between the photo list this device loaded and the list it wants
 * to save. The save path must never write the whole array back: another device
 * or a background retry can attach a photo between load and save, and a full
 * replacement erases it (RED TEAM #683 HIGH).
 *
 * A membership-only delta missed "Make Hero": moving a photo to the front kept
 * the same set, so the local strip showed the new hero while photo_urls[0] on
 * the row never changed (RED TEAM #683 MEDIUM). Reordering is its own delta so
 * it can be applied after the atomic add/remove.
 */
export function planPhotoDelta(base: readonly string[], desired: readonly string[]): PhotoDelta {
  const baseSet = new Set(base);
  const desiredSet = new Set(desired);
  const added = desired.filter((url) => !baseSet.has(url));
  const removed = base.filter((url) => !desiredSet.has(url));
  // The order the row will have after the add/remove delta lands: the photos
  // this device already knew about, in row order, then newly added ones (the
  // append RPC puts each at the end). If that differs from `desired`, the
  // device wants an order the delta cannot express — including a brand-new
  // photo promoted to hero before Save, which used to be appended last
  // (RED TEAM #683 MEDIUM).
  const afterDelta = [...base.filter((url) => desiredSet.has(url)), ...added];
  const reorder =
    afterDelta.length > 1 && afterDelta.join('\u0000') !== desired.join('\u0000')
      ? [...desired]
      : undefined;
  return {
    added,
    removed,
    ...(reorder ? { reorder } : {}),
  };
}

export type PhotoDeltaResult = { ok: true } | { ok: false; reason: string };

/**
 * Apply only the additions and removals, each in its own atomic statement
 * (0489 append, 0491 remove). A URL attached concurrently by another device is
 * neither in `base` nor in `removed`, so it survives.
 */
export async function applyLotPhotoDelta(
  lotId: string,
  operatorId: string,
  base: readonly string[],
  desired: readonly string[],
): Promise<PhotoDeltaResult> {
  const { added, removed, reorder } = planPhotoDelta(base, desired);

  if (removed.length > 0) {
    const { data, error } = await supabase.rpc('remove_lot_photo_urls', {
      p_lot_id: lotId,
      p_operator_id: operatorId,
      p_urls: removed,
    });
    if (error) return { ok: false, reason: error.message };
    if ((data as { ok?: unknown } | null)?.ok !== true) {
      return { ok: false, reason: 'remove_failed' };
    }
  }

  for (const url of added) {
    const { data, error } = await supabase.rpc('append_lot_photo_url', {
      p_lot_id: lotId,
      p_operator_id: operatorId,
      p_url: url,
    });
    if (error) return { ok: false, reason: error.message };
    if ((data as { ok?: unknown } | null)?.ok !== true) {
      return { ok: false, reason: 'append_failed' };
    }
  }

  // Order last: the row now holds the intended set, so one statement can set
  // the order without re-adding a photo another device removed.
  if (reorder) {
    const { data, error } = await supabase.rpc('reorder_lot_photo_urls', {
      p_lot_id: lotId,
      p_operator_id: operatorId,
      p_urls: reorder,
    });
    if (error) return { ok: false, reason: error.message };
    if ((data as { ok?: unknown } | null)?.ok !== true) {
      return { ok: false, reason: 'reorder_failed' };
    }
  }

  return { ok: true };
}
