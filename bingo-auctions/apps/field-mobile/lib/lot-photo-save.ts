import {
  drainPhotoQueue,
  enqueueLotPhoto,
  listPhotoQueue,
  type EnqueueResult,
  type PhotoQueueEntry,
} from './photo-upload-queue';
import { isLocalPhotoUri } from '@/features/lotting/uploadPendingPhotos';

export type LotPhotoInput = {
  kind: 'hero' | 'condition' | 'stock';
  uri: string;
};

export type LotPhotoOutcome = {
  /** The hero is durably queued (or already attached), not necessarily uploaded. */
  heroOk: boolean;
  conditionsAttempted: number;
  conditionsOk: number;
  stockCount: number;
  stockDropped: number;
  remaining: number;
  /**
   * Photos that were never accepted by the queue (missing file with no receipt,
   * queue full, storage error). They are not in `remaining`, which counts the
   * durable queue, and the screen must keep the draft for them even when the
   * queue itself is empty (RED TEAM #683 HIGH). The entries are kept so the
   * screen can offer a retry instead of only a count (RED TEAM #683 MEDIUM).
   */
  unresolved: number;
  unresolvedPhotos: LotPhotoInput[];
};

type Args = {
  lotId: string;
  lotCode: string;
  operatorId: string;
  photos: LotPhotoInput[];
  remoteStockCount: number;
};

/**
 * Queue every local photo for a saved lot and return immediately.
 *
 * The queue is the durable record: a kill after this returns leaves the entries
 * in AsyncStorage and the files in Documents. The drain runs in the background,
 * so a slow or offline network never holds the save screen for eight seconds
 * (RED TEAM #683 finding 7). A photo that is gone from disk counts as done only
 * when an upload receipt proves it was attached; otherwise it is reported as
 * remaining so the draft is kept and staff see an honest failure.
 */
export async function queueAndDrainLotPhotos({
  lotId,
  lotCode,
  operatorId,
  photos,
  remoteStockCount,
}: Args): Promise<LotPhotoOutcome> {
  const attempted: { photo: LotPhotoInput; result: EnqueueResult }[] = [];
  for (const photo of photos) {
    // A non-local URI (already a CDN URL) has nothing to upload.
    if (!isLocalPhotoUri(photo.uri)) continue;
    const result = await enqueueLotPhoto({ lotId, lotCode, operatorId, localUri: photo.uri });
    attempted.push({ photo, result });
  }

  const accepted = (entry: { result: EnqueueResult }) =>
    entry.result.id != null || entry.result.status === 'replay';

  // Read the durable queue before starting the drain so the returned pending
  // count is deterministic: queued photos are safe even if the drain has not
  // finished. If the read fails, fall back to the ids we just accepted.
  let pendingForLot: PhotoQueueEntry[] = [];
  try {
    pendingForLot = (await listPhotoQueue()).filter((entry) => entry.lotId === lotId);
  } catch {
    pendingForLot = [];
  }
  const queuedIds = new Set(
    attempted.map((entry) => entry.result.id).filter((id): id is string => typeof id === 'string'),
  );
  const pendingCount = Math.max(pendingForLot.length, queuedIds.size);

  // Fire and forget: the queue retries on foreground, capture and its own
  // timed backoff. Nothing on this screen waits for it.
  void drainPhotoQueue().catch(() => {});

  const heroAttempt = attempted.find((entry) => entry.photo.kind === 'hero');
  const conditions = attempted.filter((entry) => entry.photo.kind === 'condition');
  const stock = attempted.filter((entry) => entry.photo.kind === 'stock');

  // Never queued: missing file with no receipt, queue full, storage error.
  // These are the photos the old code silently assumed had already uploaded.
  const neverQueued = attempted.filter((entry) => !accepted(entry));

  const stockQueued = stock.filter((entry) => accepted(entry)).length;

  return {
    heroOk: !heroAttempt ? true : accepted(heroAttempt),
    conditionsAttempted: conditions.length,
    conditionsOk: conditions.filter((entry) => accepted(entry)).length,
    stockCount: remoteStockCount + stockQueued,
    stockDropped: stock.length - stockQueued,
    remaining: pendingCount + neverQueued.length,
    unresolved: neverQueued.length,
    unresolvedPhotos: neverQueued.map((entry) => entry.photo),
  };
}
