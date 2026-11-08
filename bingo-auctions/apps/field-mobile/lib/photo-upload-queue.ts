// Persistent photo upload queue for already-saved lots.
//
// Photos are copied into Documents before queueing, so an app kill/restart
// does not lose them. The queue survives in AsyncStorage and drains on app
// start, on foreground, and right after a capture. A successful upload is
// paired with a PATCH to lots.photo_urls; if the PATCH fails, the uploaded URL
// is kept in the entry so the next drain only retries the PATCH.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@auction-platform/supabase-client';
import { uploadImageFromUri } from '@/lib/upload-image';
import { compressToJpegUri } from '@/lib/image-compress';
import { deletePersistedPhoto, persistedPhotoExists } from '@/lib/persist-photo';
import { isLocalPhotoUri } from '@/features/lotting/uploadPendingPhotos';
import { PHOTO_QUEUE_KEY, PHOTO_QUEUE_CORRUPT_KEY, PHOTO_RECEIPTS_KEY } from './photo-queue-key';

const MAX_ENTRIES = 200;
const MAX_RECEIPTS = 500;

export type PhotoQueueEntry = {
  id: string;
  lotId: string;
  lotCode: string;
  operatorId: string;
  localUri: string;
  createdAt: number;
  attempts: number;
  uploadedUrl: string | null;
};

export type EnqueuePhotoInput = {
  lotId: string;
  lotCode: string;
  operatorId: string;
  localUri: string;
};

export type DrainPhotoResult = {
  uploaded: number;
  failed: number;
  uploadedUrls: { lotId: string; url: string }[];
};

/** A local file that was successfully uploaded and attached to its lot. */
export type PhotoReceipt = {
  lotId: string;
  localUri: string;
  url: string;
  at: number;
};

export type EnqueueStatus =
  | 'queued'
  | 'exists'
  | 'replay'
  | 'missing'
  | 'full'
  | 'invalid'
  | 'error';

export type EnqueueResult = { id: string | null; status: EnqueueStatus };

// Last count we successfully read, per lot. A transient storage failure on a
// display path must not read as "nothing waiting": the badge would claim the
// queue is empty while the photo is still on this phone.
let lastKnownTotal: number | null = null;
const lastKnownByLot = new Map<string, number>();

const changeListeners = new Set<() => void>();

/** Notified after the persisted queue changes (enqueue, persist, drain end). */
export function subscribePhotoQueue(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function notifyQueueChanged(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      /* a listener must never break the queue */
    }
  }
}

async function readAll(): Promise<PhotoQueueEntry[]> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(PHOTO_QUEUE_KEY);
  } catch {
    // A transient read failure must never look like an empty queue. Callers
    // would then write a fresh list and erase every accepted photo.
    throw new Error('photo_queue_read_failed');
  }
  if (!raw) {
    lastKnownTotal = 0;
    lastKnownByLot.clear();
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as PhotoQueueEntry[];
    const entries = Array.isArray(parsed) ? parsed : [];
    lastKnownTotal = entries.length;
    lastKnownByLot.clear();
    for (const entry of entries) {
      lastKnownByLot.set(entry.lotId, (lastKnownByLot.get(entry.lotId) ?? 0) + 1);
    }
    return entries;
  } catch {
    // Corrupt JSON cannot be recovered, but keep a copy for diagnosis rather
    // than quietly overwriting it on the next write.
    await AsyncStorage.setItem(PHOTO_QUEUE_CORRUPT_KEY, raw).catch(() => {});
    return [];
  }
}

async function writeAll(entries: PhotoQueueEntry[]): Promise<void> {
  // Storage failure is a real failure: never report a photo as queued when the
  // write did not land. The caller keeps the file in Documents and must alert.
  if (entries.length > MAX_ENTRIES) throw new Error('photo_queue_full');
  await AsyncStorage.setItem(PHOTO_QUEUE_KEY, JSON.stringify(entries));
  lastKnownTotal = entries.length;
  lastKnownByLot.clear();
  for (const entry of entries) {
    lastKnownByLot.set(entry.lotId, (lastKnownByLot.get(entry.lotId) ?? 0) + 1);
  }
  notifyQueueChanged();
}

/** Receipts are best-effort evidence; an unreadable store means "no proof". */
async function readReceipts(): Promise<PhotoReceipt[]> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(PHOTO_RECEIPTS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PhotoReceipt[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeReceiptLocked(entry: PhotoQueueEntry, url: string): Promise<void> {
  try {
    const receipts: PhotoReceipt[] = (await readReceipts()).filter(
      (receipt) => !(receipt.lotId === entry.lotId && receipt.localUri === entry.localUri),
    );
    receipts.push({ lotId: entry.lotId, localUri: entry.localUri, url, at: Date.now() });
    while (receipts.length > MAX_RECEIPTS) receipts.shift();
    await AsyncStorage.setItem(PHOTO_RECEIPTS_KEY, JSON.stringify(receipts));
  } catch {
    // A receipt is not the upload itself; a failed write only means a later
    // retry cannot dedupe this file and will report it instead of guessing.
  }
}

// Every read-modify-write of the stored queue goes through this single lock.
// Enqueue and drain used separate tails before, so a photo enqueued between
// the drain's final read and write was overwritten and lost. Network work
// stays outside the lock; only the storage mutation is serialized.
let storageTail: Promise<unknown> = Promise.resolve();

function withStorageLock<T>(task: () => Promise<T>): Promise<T> {
  const run = storageTail.then(task);
  storageTail = run.catch(() => {});
  return run;
}

let drainTail: Promise<unknown> = Promise.resolve();

/**
 * Queue a photo and report *why* it was not queued.
 *
 * The whole decision runs under the storage lock: the file/receipt check and
 * the queue write used to be separate reads, so a restore pass could see an
 * entry that the drain had just finished, find the file already deleted, and
 * enqueue a phantom photo. Only a receipt for this exact (lot, file) pair
 * proves an earlier upload; a missing file without one is a failure, not a
 * success.
 */
export async function enqueueLotPhoto(input: EnqueuePhotoInput): Promise<EnqueueResult> {
  try {
    return await withStorageLock(async () => {
      if (!input.localUri || !input.lotId) return { id: null, status: 'invalid' };
      const entries = await readAll();
      const existing = entries.find(
        (entry) => entry.lotId === input.lotId && entry.localUri === input.localUri,
      );
      if (existing) return { id: existing.id, status: 'exists' };
      if (isLocalPhotoUri(input.localUri) && !(await persistedPhotoExists(input.localUri))) {
        const receipts = await readReceipts();
        const replayed = receipts.some(
          (receipt) => receipt.lotId === input.lotId && receipt.localUri === input.localUri,
        );
        return replayed ? { id: null, status: 'replay' } : { id: null, status: 'missing' };
      }
      if (entries.length >= MAX_ENTRIES) return { id: null, status: 'full' };
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      entries.push({
        id,
        lotId: input.lotId,
        lotCode: input.lotCode,
        operatorId: input.operatorId,
        localUri: input.localUri,
        createdAt: Date.now(),
        attempts: 0,
        uploadedUrl: null,
      });
      await writeAll(entries);
      return { id, status: 'queued' };
    });
  } catch {
    return { id: null, status: 'error' };
  }
}

export async function enqueuePhotoUpload(input: EnqueuePhotoInput): Promise<string | null> {
  return (await enqueueLotPhoto(input)).id;
}

export async function listPhotoQueue(): Promise<PhotoQueueEntry[]> {
  return readAll();
}

export async function photoQueueCount(lotId?: string): Promise<number> {
  const entries = await readAll();
  return lotId ? entries.filter((entry) => entry.lotId === lotId).length : entries.length;
}

/**
 * Display-only count: a transient storage read must not crash a screen.
 *
 * Returns `null` when nothing has ever been read on this process, so a cold
 * launch with queued photos and an unreadable store reports "unknown" instead
 * of zero. Zero would tell staff the photos are done when they may still be
 * waiting on this phone.
 */
export async function photoQueueCountSafe(lotId?: string): Promise<number | null> {
  try {
    return await photoQueueCount(lotId);
  } catch {
    if (lotId) return lastKnownByLot.get(lotId) ?? null;
    return lastKnownTotal;
  }
}

async function patchLotPhoto(lotId: string, operatorId: string, url: string): Promise<boolean> {
  // appends server-side, inside one row update. A SELECT-then-write erased a
  // photo another device attached between the two statements, and a zero-row
  // update used to report success. 0489 returns ok:false for both.
  const { data, error } = await supabase.rpc('append_lot_photo_url', {
    p_lot_id: lotId,
    p_operator_id: operatorId,
    p_url: url,
  });
  if (error || !data) return false;
  return (data as { ok?: unknown }).ok === true;
}

async function drainOnce(): Promise<DrainPhotoResult> {
  const result: DrainPhotoResult = { uploaded: 0, failed: 0, uploadedUrls: [] };
  const entries = await readAll();
  if (entries.length === 0) return result;

  const next: PhotoQueueEntry[] = [];
  for (const entry of entries) {
    let uploadedUrl = entry.uploadedUrl;
    if (!uploadedUrl) {
      try {
        // Always use the operator the photo was captured for. Resolving the
        // current operator here routed a queued photo into another tenant's
        // upload namespace after an operator switch, before the original-lot
        // PATCH could fail.
        const operatorId = entry.operatorId;
        if (!operatorId) {
          next.push({ ...entry, attempts: entry.attempts + 1 });
          result.failed += 1;
          continue;
        }
        const compressed = await compressToJpegUri(entry.localUri);
        const path = `${operatorId}/${entry.lotCode || '_pending'}/queued-${entry.id}.jpg`;
        const upload = await uploadImageFromUri('lot-photos', path, compressed, {
          contentType: 'image/jpeg',
          upsert: true,
        });
        if (!upload.ok) {
          next.push({ ...entry, attempts: entry.attempts + 1 });
          result.failed += 1;
          continue;
        }
        uploadedUrl = upload.url;
        // Persist the URL before patching so a kill here retries only the PATCH.
        await withStorageLock(async () => {
          const persisted = await readAll();
          await writeAll(
            persisted.map((candidate) =>
              candidate.id === entry.id ? { ...candidate, uploadedUrl } : candidate,
            ),
          );
        });
      } catch {
        next.push({ ...entry, attempts: entry.attempts + 1 });
        result.failed += 1;
        continue;
      }
    }

    const patched = await patchLotPhoto(entry.lotId, entry.operatorId, uploadedUrl);
    if (!patched) {
      next.push({ ...entry, attempts: entry.attempts + 1, uploadedUrl });
      result.failed += 1;
      continue;
    }

    await withStorageLock(() => writeReceiptLocked(entry, uploadedUrl));

    await deletePersistedPhoto(entry.localUri);
    result.uploaded += 1;
    result.uploadedUrls.push({ lotId: entry.lotId, url: uploadedUrl });
  }

  // Remove only entries this drain started with and did NOT keep. Anything
  // enqueued while the drain was running is new work and must survive.
  const started = new Set(entries.map((entry) => entry.id));
  const kept = new Set(next.map((entry) => entry.id));
  await withStorageLock(async () => {
    const current = await readAll();
    await writeAll(current.filter((entry) => !started.has(entry.id) || kept.has(entry.id)));
  });
  return result;
}

export async function drainPhotoQueue(): Promise<DrainPhotoResult> {
  const run = drainTail.then(() => drainOnce());
  drainTail = run.catch(() => {});
  return run;
}
