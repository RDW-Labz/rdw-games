// Shared sticker-binding logic for lotting.
//
// ONE place owns the "bind a scanned code to a lot" dispatch so the two callers
// stay in lock-step:
//   1. quick.tsx — Option B single-scan: the code that CREATES the lot in
//      Pre-stickered mode is immediately bound here (no second scan).
//   2. PreStickeredScanner.tsx — the fallback modal (manual / photo / web /
//      scan-tab entry screens, or when an auto-bind fails) calls this too.
//
// Routing is by the scanned VALUE, not a mode toggle:
//   - a UUID (bare, or embedded in a bingoauctions.com/l/<uuid> universal link) is a
//     BinGo Auctions pre-printed QR  → claim_prestickered_qr (rotates lots.qr_token)
//   - any other non-empty code is the operator's own label (LPN, vendor
//     barcode, BRN, DataMatrix) → claim_sticker_code (lots.sticker_code; the
//     server stores it operator-prefixed as "{op.code}:RAW")
// Both RPCs are idempotent for a re-claim of the same code onto the same lot.

import { supabase } from '@auction-platform/supabase-client';
import { isValidGtinCheckDigit, looksLikeCarrierBarcode } from '@auction-platform/domain-lotting';
import { BIND_TIMEOUT_MS, BIND_TIMEOUT_REASON, withTimeout } from '@/lib/sticker-bind-queue';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * A scanned value that IS a retail product barcode, not a lot sticker.
 * Tester recap 2026-07-08 §7: the camera catching the product's UPC/EAN next
 * to the pre-lot sticker silently bound the UPC as the lot's code (e.g.
 * "5407007656684 — Pillowcase"). A bare 12/13/14-digit numeric with a valid
 * GS1 check digit is a UPC-A/EAN-13/GTIN-14 — BinGo pre-printed stickers are
 * UUID QRs and operator labels are alphanumeric (BRN…/LPN…/TEA…), so a true
 * sticker never looks like this. Staff who genuinely need a numeric code can
 * still type it via Edit code (which calls the RPC directly, not this guard).
 */
export function looksLikeProductBarcode(raw: string): boolean {
  const t = raw.trim();
  if (!/^\d{12,14}$/.test(t)) return false;
  return isValidGtinCheckDigit(t);
}

/**
 * The wider guard the one above should have been (field report 2026-08-02).
 *
 * `looksLikeProductBarcode` only fires when a 12-14 digit numeric carries a
 * valid GS1 check digit. FedEx tracking is 12 digits with a mod-11 check, so it
 * failed that test and bound itself as three lots' stickers that morning; the
 * 34-digit FedEx `9622…` block is not a GTIN length at all. Wayfair returns
 * arrive on FedEx labels and mis-scan at 0.70% against 0.11% everywhere else —
 * the label's barcode simply wins the camera frame over the colour sticker.
 *
 * The shape rule (bare 8+ digit numeric, or a UPS 1Z code) lives in
 * domain-lotting so it is unit-tested, and is enforced for real by mig 0308 in
 * claim_sticker_code / rebind_sticker_code. Checking here too keeps the
 * round-trip off the hot path and lets us show the more specific "that's the
 * product's UPC" copy when the code really is a retail barcode.
 */
export { looksLikeCarrierBarcode };

/** Pull a UUID out of a raw scan. Accepts a bare UUID, a universal-link URL
 *  (https://bingoauctions.com/l/<uuid>), or any string embedding a UUID. Returns
 *  null when no UUID is present (→ treat the raw value as an operator label). */
export function extractTokenFromScan(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = UUID_RE.exec(trimmed);
  if (direct) return direct[0];
  const anywhere = trimmed.match(UUID_ANYWHERE_RE);
  return anywhere?.[1] ?? null;
}

export type BindStickerResult =
  | { ok: true; lot_id: string; qr_token?: string; sticker_code?: string; idempotent: boolean }
  | { ok: false; reason: string; other_lot_id?: string; other_lot_code?: string };

/** Friendly copy for the failure reasons both RPCs can return. Shared so the
 *  modal and any inline surface render the same messages. */
export const STICKER_REASON_COPY: Record<string, string> = {
  // claim_prestickered_qr reasons
  qr_token_already_used:
    'This sticker is already on another lot. Scan a different one or use the auto-generated QR.',
  lot_not_found: "Couldn't find the lot — pull to refresh and retry.",
  lot_other_operator: 'That lot belongs to a different operator — sign out and back in.',
  not_operator_staff: "You're no longer signed in as staff — restart the app.",
  // claim_sticker_code reasons (W2-bonus, mig 0141)
  sticker_code_already_used: 'That code is already on another lot. Scan a different one.',
  lot_already_has_different_sticker:
    'This lot already has a different sticker code. Open Inventory to change it.',
  // Duplicate-twin prevention (mig 0283): the code is another LIVE lot's code.
  raw_code_is_live_lot_code:
    "That code is already lotted as a live lot. Open that lot, or use Relot for a returned item — don't create a second lot for it.",
  empty_raw_code: 'The scanned code is empty — try again.',
  raw_code_too_long: 'That code is too long (max 200 chars).',
  raw_code_contains_colon: 'Code cannot contain a colon (:). Try a different code.',
  operator_code_missing: 'Operator setup issue — contact your admin.',
  // Client-side guard (2026-07-08): a retail barcode is not a lot sticker.
  looks_like_product_barcode:
    "That's the product's barcode (UPC), not a lot sticker. Aim at the BinGo sticker and scan again.",
  // Carrier shipping label (2026-08-02, mig 0308). Returned by the client guard
  // AND by claim_sticker_code / rebind_sticker_code, so old app builds that
  // predate the client check still render this copy.
  raw_code_looks_like_carrier_barcode:
    "That's the shipping label (FedEx/UPS tracking), not a lot sticker. Aim at the pink, brown or teal BinGo sticker and scan again.",
  // No answer within BIND_TIMEOUT_MS (2026-10-08, bad warehouse wifi).
  [BIND_TIMEOUT_REASON]: 'Server slow: the sticker is not attached yet. Scan it again.',
};

/**
 * The pre-RPC checks on a scanned sticker, on their own, so the capture step
 * that runs BEFORE a lot exists (2026-10-05: sticker before save) refuses the
 * same mis-scans the bind does: empty, a retail barcode, a carrier label.
 * Typed codes waive the barcode guards, exactly as in bindStickerToLot.
 */
export function validateStickerScan(
  rawCode: string,
  opts?: { manualEntry?: boolean },
): { ok: true; code: string } | { ok: false; reason: string } {
  const trimmed = rawCode.trim();
  if (!trimmed) return { ok: false, reason: 'empty_raw_code' };
  if (!opts?.manualEntry) {
    if (looksLikeProductBarcode(trimmed)) return { ok: false, reason: 'looks_like_product_barcode' };
    if (looksLikeCarrierBarcode(trimmed)) return { ok: false, reason: 'raw_code_looks_like_carrier_barcode' };
  }
  return { ok: true, code: trimmed };
}

/**
 * Bind a raw scanned code to a lot. Never throws — every failure path returns
 * `{ ok: false, reason }` so callers can branch (auto-bind → fall back to the
 * modal; modal → render STICKER_REASON_COPY[reason]).
 */
export async function bindStickerToLot(
  lotId: string,
  rawCode: string,
  opts?: {
    /** Scan-recovery mode (mig 0249): replace an EXISTING sticker_code instead
     *  of rejecting with lot_already_has_different_sticker. Routes non-UUID
     *  codes to rebind_sticker_code, which audit-logs the old→new change. */
    rebind?: boolean;
    /** Deliberate manual entry (mig 0308). A code someone TYPED is not a
     *  mis-scan, so the carrier/retail barcode guard is waived — some boxes
     *  genuinely carry a numeric label and staff need a way in. Camera paths
     *  must never set this: a camera scan is the exact thing being defended
     *  against. Threads through to p_override_barcode_guard on the RPC. */
    manualEntry?: boolean;
    /** Give up after this long (default BIND_TIMEOUT_MS) with reason
     *  'bind_timeout'. 2026-10-08: with no limit, a request on bad wifi held
     *  the lotting screen until it was killed; Android's RN HTTP client has
     *  no timeout of its own. Both RPCs are idempotent for the same lot and
     *  code, so trying again after a timeout is safe. */
    timeoutMs?: number;
  },
): Promise<BindStickerResult> {
  const trimmed = rawCode.trim();
  if (!trimmed) return { ok: false, reason: 'empty_raw_code' };
  // Reject barcode shapes BEFORE any RPC — the #1 mis-scan is the camera
  // catching something other than the sticker: the item's UPC (recap
  // 2026-07-08 §7) or, on Wayfair returns, the FedEx label (2026-08-02).
  // Typed codes skip this; mig 0308 enforces the same rule server-side, which
  // is what actually covers app builds older than this check.
  if (!opts?.manualEntry) {
    if (looksLikeProductBarcode(trimmed)) {
      return { ok: false, reason: 'looks_like_product_barcode' };
    }
    if (looksLikeCarrierBarcode(trimmed)) {
      return { ok: false, reason: 'raw_code_looks_like_carrier_barcode' };
    }
  }
  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? BIND_TIMEOUT_MS;
  const timedOut: BindStickerResult = { ok: false, reason: BIND_TIMEOUT_REASON };
  try {
    const token = extractTokenFromScan(trimmed);
    const request = token
      ? supabase
          .rpc('claim_prestickered_qr', { p_lot_id: lotId, p_qr_token: token })
          .abortSignal(controller.signal)
      : supabase
          .rpc(opts?.rebind ? 'rebind_sticker_code' : 'claim_sticker_code', {
            p_lot_id: lotId,
            p_raw_code: trimmed,
            p_override_barcode_guard: opts?.manualEntry ?? false,
          })
          .abortSignal(controller.signal);
    const call = (async (): Promise<BindStickerResult> => {
      const { data, error } = (await request) as { data: unknown; error: unknown };
      if (error) {
        return { ok: false, reason: (error as { message?: string }).message ?? 'rpc_error' };
      }
      return data as BindStickerResult;
    })();
    const result = await withTimeout(call, timeoutMs, () => {
      controller.abort();
      return timedOut;
    });
    return result;
  } catch (err) {
    if (controller.signal.aborted) return timedOut;
    return { ok: false, reason: (err as Error).message || 'unknown_error' };
  }
}
