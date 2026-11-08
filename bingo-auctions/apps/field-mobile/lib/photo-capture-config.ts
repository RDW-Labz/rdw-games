// Lotting /lotting/photo capture limits — keeps still captures off the ~12 MP
// full-sensor path (~4032×3024) and closer to ~2.8 MP (1920×1440) so decode +
// compress peaks stay survivable on the oldest staff iPads.
//
// How to measure (before/after this cap on a target device):
//   1. Xcode → Product → Profile → Allocations (or Memory Graph) on the oldest
//      iPad you care about; open Lotting → AI Photo, capture hero + 2 condition
//      shots while AI runs.
//   2. Record peak resident memory during the 3-shot + AI compress window.
//   3. In Metro / Safari Web Inspector, filter logs for "[photo-capture]" and
//      record per shot: formatPhotoWxH, takenPhotoWxH, fileSizeBytes,
//      compressDurationMs.
//   4. Compare peaks and compress ms with cap ON vs reverting format prop.

import type { CameraDeviceFormat } from 'react-native-vision-camera';

/** ~2.8 MP still cap vs ~12 MP full sensor on typical iPhone/iPad back cameras. */
export const CAPTURE_MAX_PHOTO_PX = { width: 1920, height: 1440 } as const;

/** Passed to `useCameraFormat(device, filters)` on the lotting photo screen. */
export const CAMERA_PHOTO_FORMAT_FILTERS = [{ photoResolution: CAPTURE_MAX_PHOTO_PX }];

export type PhotoPixelCap = { width: number; height: number };

export function photoFormatFitsCap(
  format: CameraDeviceFormat,
  cap: PhotoPixelCap,
): boolean {
  return format.photoWidth <= cap.width && format.photoHeight <= cap.height;
}

/**
 * Among `formats`, pick the largest photo resolution that does not exceed `cap`
 * on either axis. Returns undefined when no format fits (caller omits `format` prop).
 */
export function selectLargestPhotoFormatAtOrUnderCap(
  formats: readonly CameraDeviceFormat[],
  cap: PhotoPixelCap,
): CameraDeviceFormat | undefined {
  if (formats.length === 0) return undefined;

  let best: CameraDeviceFormat | undefined;
  let bestPixels = 0;

  for (const f of formats) {
    if (!photoFormatFitsCap(f, cap)) continue;
    const pixels = f.photoWidth * f.photoHeight;
    if (pixels > bestPixels) {
      bestPixels = pixels;
      best = f;
    }
  }

  return best;
}

export type PhotoCaptureLogPayload = {
  formatPhoto?: { width: number; height: number };
  takenPhoto: { width: number; height: number };
  fileSizeBytes?: number;
  compressDurationMs?: number;
};

export function logPhotoCapture(payload: PhotoCaptureLogPayload): void {
  const fmt = payload.formatPhoto
    ? `${payload.formatPhoto.width}×${payload.formatPhoto.height}`
    : 'n/a';
  const taken = `${payload.takenPhoto.width}×${payload.takenPhoto.height}`;
  const bytes = payload.fileSizeBytes ?? 'n/a';
  const compressMs = payload.compressDurationMs ?? 'n/a';
  console.info(
    `[photo-capture] format=${fmt} taken=${taken} bytes=${bytes} compressMs=${compressMs}`,
  );
}

export type VisionCompressInput = {
  uri: string;
  width?: number;
  height?: number;
  /** Optional capture metadata for logging after compress. */
  captureLog?: Omit<PhotoCaptureLogPayload, 'compressDurationMs' | 'takenPhoto'> & {
    takenPhoto?: { width: number; height: number };
  };
};

/**
 * Compress up to 3 photos for scanPhoto — one at a time so only one decode
 * resident in memory.
 */
export async function compressForVisionSequential(
  photos: readonly VisionCompressInput[],
  compressFn: (
    uri: string,
    dims?: { width: number; height: number },
  ) => Promise<string>,
): Promise<Array<{ base64: string; mediaType: 'image/jpeg' }>> {
  const out: Array<{ base64: string; mediaType: 'image/jpeg' }> = [];
  for (const photo of photos) {
    const t0 = Date.now();
    const dims =
      photo.width != null &&
      photo.height != null &&
      Number.isFinite(photo.width) &&
      Number.isFinite(photo.height)
        ? { width: photo.width, height: photo.height }
        : undefined;
    const b64 = await compressFn(photo.uri, dims);
    const compressDurationMs = Date.now() - t0;
    if (photo.captureLog) {
      logPhotoCapture({
        formatPhoto: photo.captureLog.formatPhoto,
        takenPhoto: photo.captureLog.takenPhoto ?? {
          width: photo.width ?? 0,
          height: photo.height ?? 0,
        },
        fileSizeBytes: photo.captureLog.fileSizeBytes,
        compressDurationMs,
      });
    }
    if (!b64) throw new Error('Photo compression returned empty data');
    out.push({ base64: b64, mediaType: 'image/jpeg' });
  }
  return out;
}
