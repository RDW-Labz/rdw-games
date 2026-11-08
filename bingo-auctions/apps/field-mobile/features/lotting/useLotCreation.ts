// Shared lot-creation hook used by scan, upc, and quick screens.
//
// Wraps createDraftLotFromCandidate (which calls next_lot_code RPC and
// inserts into `lots`) and adds the photo-upload step:
//
//   1. Compress local URI via expo-image-manipulator (1200px, JPEG 0.75)
//   2. Upload blob to `lot-photos` bucket at lots/{operatorId}/{lotCode}/{ts}.jpg
//   3. Pass the public URL to createDraftLotFromCandidate as photoUrls[0]
//
// Returns { create, creating, lastCreated } so callers can show toast +
// reset after success.
//
// OFFLINE RESILIENCE GAP:
//   Lot creation is a direct Supabase insert. If the device is offline
//   the call will throw. A proper queue would use expo-file-system to
//   persist a draft JSON, retry on reconnect, and back-fill photo_urls.
//   That queue is NOT implemented here. Callers should check connectivity
//   before calling `create` and surface an error when offline.
//   TODO(platform-team): add `lot_drafts` local-first queue using
//   expo-sqlite or react-native-mmkv + a BullMQ worker that flushes on
//   reconnect.

import { useCallback, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import {
  createDraftLotFromCandidate,
  type LotCandidate,
  type CreateDraftLotFailureCode,
} from '@auction-platform/domain-lotting';
import {
  supabase,
  useOperatorRole,
  resolveOperatorIdForUpload,
} from '@auction-platform/supabase-client';
import { useLottingSession } from './SessionContext';
import { uploadImageFromUri } from '../../lib/upload-image';

// ── Typed error so the calling screen can render friendly copy ──────────────
//
// The callers (scan.tsx, quick.tsx) catch this and read `.code` to decide
// the message. Keeping the raw `reason` lets engineers see the underlying
// Postgres error in logs / "Show details" without exposing it to the user.

export class LotCreateError extends Error {
  constructor(
    public readonly code: CreateDraftLotFailureCode,
    /** User-facing message — already localized for display in an Alert. */
    public readonly userMessage: string,
    /** Raw underlying error message for logs. */
    reason: string,
  ) {
    super(userMessage);
    this.name = 'LotCreateError';
    // Stash the raw reason on a field for debug hooks; UI uses .userMessage.
    (this as unknown as { reason: string }).reason = reason;
  }
}

/** Map a discriminated failure code to user-facing copy. */
function userMessageFor(code: CreateDraftLotFailureCode): string {
  switch (code) {
    case 'duplicate_external_code':
      return (
        "This UPC is already on another lot in your inventory. " +
        "Open Inventory to find the existing lot, or scan a different code."
      );
    case 'rpc_failed':
      return "Couldn't reserve a lot code. Check your connection and try again.";
    case 'insert_failed':
      return "Couldn't save the lot. Try again — if it keeps failing, open the support tab.";
  }
}

export type LotCreationInput = {
  candidate: LotCandidate;
  /** Local file:// URI of the photo captured by the worker. Compressed
   *  to 1200px / JPEG 0.75 before upload. Omit to skip photo upload. */
  capturedPhotoUri?: string;
};

export type CreatedLot = {
  lotId: string;
  lotCode: string;
  title: string;
  /**
   * Photo upload outcome:
   *   'none'    — no photo was attempted (capturedPhotoUri was undefined)
   *   'pending' — photo upload was triggered as fire-and-forget after the
   *               lot row committed (2026-05-21 perf change). The upload
   *               is best-effort in the background; failure is silently
   *               swallowed and the lot ends up with the stockPhotos
   *               array only. Operator can retry from Inventory.
   *   'ok'      — photo uploaded + linked successfully (synchronous path)
   *   'failed'  — lot was saved but photo upload or link failed.
   *               photoErrorReason carries a short, user-readable hint.
   */
  photoStatus: 'none' | 'pending' | 'ok' | 'failed';
  /** Set when photoStatus === 'failed'. Trimmed to ~80 chars. */
  photoErrorReason?: string;
};

// ── Image compression ────────────────────────────────────────────────────────

const MAX_DIM = 1200;
const JPEG_QUALITY = 0.75;

async function compressToJpeg(uri: string): Promise<string> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: MAX_DIM, height: MAX_DIM } }],
    {
      compress: JPEG_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    },
  );
  return result.uri;
}

// ── Photo upload ─────────────────────────────────────────────────────────────

type PhotoUploadResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

async function uploadLotPhoto(
  operatorId: string,
  lotCode: string,
  localUri: string,
): Promise<PhotoUploadResult> {
  // Compress to 1200px / JPEG 0.75 first to keep upload payload small.
  const compressedUri = await compressToJpeg(localUri);

  // Path layout enforced by the lot-photos Storage RLS policy
  // (`(storage.foldername(name))[1] = current_operator_id()::text` —
  // see migrations 0004 + 0028). FIRST segment MUST be the operator id.
  //
  // DATA-LOSS FIX: `operatorId` is passed down from
  // useOperatorRole().operatorId, which is `undefined` during a loading /
  // transient-downgrade window → a `undefined/…` path fails RLS and the
  // photo is silently dropped. Resolve the id from the same source the
  // server's current_operator_id() uses so the segment always matches;
  // fall back to the caller's value only if the resolve returns null.
  const authoritativeOperatorId =
    (await resolveOperatorIdForUpload()) ?? (operatorId && operatorId.trim() ? operatorId : null);
  if (!authoritativeOperatorId) {
    return { ok: false, reason: 'Not signed in as staff — sign out and back in, then retry.' };
  }
  const path = `${authoritativeOperatorId}/${lotCode}/${Date.now()}.jpg`;

  // uploadImageFromUri reads the file via expo-file-system + decodes the
  // bytes to a Uint8Array. The old fetch(uri).blob() pattern returned a
  // 0-byte blob on Expo iOS — see lib/upload-image.ts header for the
  // full incident postmortem.
  const result = await uploadImageFromUri('lot-photos', path, compressedUri, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, url: result.url };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useLotCreation() {
  const role = useOperatorRole();
  const { session, pushRecentLot } = useLottingSession();
  const [creating, setCreating] = useState(false);
  const [lastCreated, setLastCreated] = useState<CreatedLot | null>(null);

  const create = useCallback(
    async (input: LotCreationInput): Promise<CreatedLot | null> => {
      if (role.kind !== 'staff') return null;
      if (creating) return null;

      setCreating(true);
      try {
        const { candidate, capturedPhotoUri } = input;
        const operatorId = role.operatorId;

        // Step 1: Create the draft lot row (reserves lot_code via RPC).
        // PERF (2026-05-21): the heavy photo-mirror + product_lookups
        // write-through used to run inside this call — adding 1-3s
        // before the user got any feedback. They now live on the
        // returned `enrich` thunk that we fire-and-forget below.
        const out = await createDraftLotFromCandidate(supabase, {
          candidate,
          operatorId,
          // We'll update photo_urls after upload; pass stock photos for now
          photoUrls: candidate.stockPhotos ?? [],
          // Source/truck label flows from the session defaults so all
          // mobile lotting paths (Scan + Quick Lot + Photo) tag lots
          // consistently. Operator changes the source on the LotTR hub.
          source: session.defaultSource || null,
          vendor: session.defaultVendor || null,
        });

        if (!out.ok) {
          // Wrap the discriminated failure in a typed error. Callers do
          // `Alert.alert("Couldn't create lot", err.message)` — passing the
          // typed userMessage produces friendly, actionable copy.
          throw new LotCreateError(out.code, userMessageFor(out.code), out.reason);
        }

        const { lotId, lotCode } = out;

        // ── Fire-and-forget background enrichment ──────────────────────
        // The thunk mirrors retailer-CDN stock photos into stock-images
        // bucket and writes the product_lookups cache. Both are
        // idempotent and best-effort; the lot is already committed in
        // Postgres with its initial CDN URLs.
        void out.enrich();

        // ── Optimistic return: photo upload is fire-and-forget ─────────
        // Pre-2026-05-21 this awaited the upload before returning,
        // adding 1-3s per save. Now we return immediately with
        // photoStatus='pending'; the upload completes in the background
        // and patches lots.photo_urls when it lands. Caller can show
        // "Saving photo…" if they want; the lot itself is safe.
        let photoStatus: CreatedLot['photoStatus'] = 'none';
        if (capturedPhotoUri) {
          photoStatus = 'pending';
          // Capture stable refs so the IIFE doesn't read stale closure vars.
          const lotIdSnap = lotId;
          const lotCodeSnap = lotCode;
          const stockPhotosSnap = candidate.stockPhotos ?? [];
          void (async () => {
            try {
              const upload = await uploadLotPhoto(operatorId, lotCodeSnap, capturedPhotoUri);
              if (!upload.ok) return; // best-effort
              await supabase
                .from('lots')
                .update({
                  // Stock photo stays the HERO (first) — the operator rule
                  // from the 2026-07-08 recap ("imported = primary"). This
                  // background patch used to put the staff capture first,
                  // silently demoting the stock image on every scanned lot
                  // (staff report 2026-07-10). Staff shots follow as
                  // condition/detail photos.
                  photo_urls: [...stockPhotosSnap, upload.url],
                })
                .eq('id', lotIdSnap);
            } catch {
              // best-effort — lot is already saved. Operator can retry
              // the photo from the Inventory edit screen.
            }
          })();
        }

        const created: CreatedLot = {
          lotId,
          lotCode,
          title: candidate.title || candidate.fullTitle || 'Lot',
          photoStatus,
        };

        setLastCreated(created);

        // Persistent clipboard — lets the operator come back to Quick Lot
        // / Scan after navigating away (or after a crash) and still see
        // what they've been working on. Same shape Quick Lot uses.
        pushRecentLot({
          lotId,
          lotCode,
          externalCode: candidate.upc || '',
          title: candidate.title || candidate.fullTitle || 'Lot',
          ...(session.defaultSource ? { source: session.defaultSource } : {}),
        });

        // Haptic success — fire-and-forget; the buzz timing doesn't gate
        // anything and awaiting it adds tens of ms for no reason.
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        return created;
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        throw err;
      } finally {
        setCreating(false);
      }
    },
    [role, creating, session.defaultSource, session.defaultVendor, pushRecentLot],
  );

  return { create, creating, lastCreated };
}

// ── Public helper for multi-photo screens ────────────────────────────────────
//
// Exported so the AI photo scan screen can upload N condition photos in
// parallel after createDraftLotFromCandidate returns the lot_code. The
// hook itself only takes a single capturedPhotoUri because it's tuned
// for Quick Lot's one-photo-after-scan pattern. Multi-photo flows
// (photo.tsx) call this directly, gather results, then PATCH
// lots.photo_urls in one round-trip.
export async function uploadLotPhotoPublic(
  operatorId: string,
  lotCode: string,
  localUri: string,
): Promise<PhotoUploadResult> {
  return uploadLotPhoto(operatorId, lotCode, localUri);
}
