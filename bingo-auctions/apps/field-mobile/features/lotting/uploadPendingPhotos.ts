// uploadPendingPhotos — upload any local file:// URIs in a photo list to the
// lot-photos bucket BEFORE a lot is created/saved, swapping each for its
// public https:// URL. Already-remote https:// URLs pass through unchanged.
//
// WHY THIS EXISTS (D4):
//   EditableCandidateCard's "+ Add photo" tile lets the operator capture new
//   photos straight into the review card's `stockPhotos`. Those arrive as
//   `file://…` URIs. Two failure modes if they reach persistence as-is:
//     - createDraftLotFromCandidate → filterSafeImageUrls() SILENTLY DROPS
//       file:// (allowlist is https-only) → the photo is lost.
//     - worklist/[id].tsx does a raw `update({ photo_urls })` with NO filter
//       → a file:// URI WOULD persist onto the row and render broken forever.
//   So callers MUST run their stockPhotos through this helper before save.
//
// Reuses uploadImageFromUri (the canonical 0-byte-safe uploader) and the
// same path conventions as quick.tsx. Path layout satisfies the lot-photos
// RLS policy (0004/0028): FIRST folder segment = operatorId.
// We don't always have a lot_code at upload time (creation paths mint it
// inside the RPC), so newly-captured photos land under
//   {operatorId}/{lotCode ?? '_pending'}/{ts}-{i}.jpg
// which is still operator-scoped and therefore RLS-legal.

import { uploadImageFromUri } from '@/lib/upload-image';
import { compressToJpegUri } from '@/lib/image-compress';
import { resolveOperatorIdForUpload } from '@auction-platform/supabase-client';
import * as FileSystem from 'expo-file-system/legacy';

/** A URI is "local" (needs upload) when it isn't already an https URL.
 *  file:// and content:// both qualify; http:// is treated as local too so
 *  a non-TLS URL never silently persists (the allowlist is https-only). */
export function isLocalPhotoUri(uri: string): boolean {
  return !/^https:\/\//i.test(uri.trim());
}

export type UploadPendingResult = {
  /** Final list: remotes preserved in place, locals replaced by public URLs.
   *  Locals that failed to upload are DROPPED (never a stale file:// URI). */
  urls: string[];
  /** Count of local URIs that failed to upload (for a "couldn't add N
   *  photos" toast). 0 = everything that needed uploading succeeded. */
  failedCount: number;
};

/** How many local (file://) URIs needed uploading. Lets callers phrase a
 *  precise "N of M photos" message and detect the total-failure case
 *  (`attemptedCount > 0 && failedCount === attemptedCount`). */
export type UploadPendingResultFull = UploadPendingResult & { attemptedCount: number };

/**
 * Upload every local URI in `photoUris` to lot-photos and return the list
 * with locals swapped for their public URLs. Remotes pass through unchanged
 * and in their original positions, so the hero (index 0) is preserved.
 *
 * Uploads run in parallel; capture order is preserved by mapping settled
 * results back to their original slots. A failed local upload is omitted
 * from the result (and counted) — GUARANTEEING no file:// URI is ever
 * returned for persistence.
 */
export async function uploadPendingPhotos(
  operatorId: string,
  photoUris: readonly string[],
  lotCode?: string,
): Promise<UploadPendingResultFull> {
  const folder = lotCode && lotCode.trim() ? lotCode.trim() : '_pending';
  const baseTs = Date.now();

  // DATA-LOSS FIX: the lot-photos INSERT RLS policy checks the path's FIRST
  // folder segment against current_operator_id()::text. The `operatorId`
  // passed in comes from useOperatorRole().operatorId, which is `undefined`
  // during a `loading` / transient-downgrade window — a path of
  // `undefined/…` fails RLS and every photo is silently dropped. Resolve the
  // id from the SAME source the server uses (operator_users for auth.uid())
  // so the segment is guaranteed to match. Fall back to the caller's value
  // only if the resolve returns null (e.g. offline getSession); if BOTH are
  // empty we can't build a legal path, so report all locals as failed rather
  // than uploading to a doomed path.
  const authoritativeOperatorId =
    (await resolveOperatorIdForUpload()) ?? (operatorId && operatorId.trim() ? operatorId : null);

  const attemptedCount = photoUris.filter((u) => u.trim() && isLocalPhotoUri(u.trim())).length;

  if (!authoritativeOperatorId) {
    // No legal first segment available → keep remotes, drop all locals, and
    // count them as failed so the caller surfaces a visible error.
    const urls = photoUris.map((u) => u.trim()).filter((u) => u && !isLocalPhotoUri(u));
    return { urls, failedCount: attemptedCount, attemptedCount };
  }

  // Per-item outcome so failedCount is exact (no brittle arithmetic):
  //   'remote'  — passed through unchanged
  //   string    — a local URI that uploaded to this public URL
  //   null      — empty slot, or a local URI that failed to upload
  //
  // SERIAL, not Promise.all (crash fix — staff report 2026-07-17 "app crashes
  // when returning with a saved stock photo"): a gallery pick arrives at full
  // resolution and uploadImageFromUri reads the file to base64 + a Uint8Array
  // (three copies in memory, ~15-25 MB each). Doing several at once OOM-killed
  // warehouse tablets natively (no JS trace) and lost the unsaved lot. We now
  // (a) compress each local to a ≤1200px JPEG BEFORE the read, and (b) process
  // one at a time, so peak memory is a single small image rather than N large
  // ones. Camera captures already compress via useLotCreation.compressToJpeg;
  // this closes the same gap for the gallery/save-to-device path.
  const settled: Array<{ kind: 'remote' | 'local' | 'empty'; url: string | null }> = [];
  for (let i = 0; i < photoUris.length; i++) {
    const trimmed = photoUris[i]!.trim();
    if (!trimmed) {
      settled.push({ kind: 'empty', url: null });
      continue;
    }
    // Already remote → pass through unchanged.
    if (!isLocalPhotoUri(trimmed)) {
      settled.push({ kind: 'remote', url: trimmed });
      continue;
    }
    try {
      const compressed = await compressToJpegUri(trimmed);
      const path = `${authoritativeOperatorId}/${folder}/${baseTs}-${i}.jpg`;
      const persisted = trimmed.startsWith(`${FileSystem.documentDirectory}lot-photos/`);
      const res = await uploadImageFromUri('lot-photos', path, compressed, {
        contentType: 'image/jpeg',
        upsert: false,
      });
      if (res.ok && persisted)
        await FileSystem.deleteAsync(trimmed, { idempotent: true }).catch(() => {});
      settled.push({ kind: 'local', url: res.ok ? res.url : null });
    } catch {
      settled.push({ kind: 'local', url: null });
    }
  }

  const urls = settled.map((r) => r.url).filter((u): u is string => u !== null);
  // A local item with url === null is a genuine upload failure.
  const failedCount = settled.filter((r) => r.kind === 'local' && r.url === null).length;

  return { urls, failedCount, attemptedCount };
}
