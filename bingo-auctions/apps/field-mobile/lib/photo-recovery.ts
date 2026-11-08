// Recovery records for a created lot whose photos never reached the upload
// queue (RED TEAM #683 HIGH).
//
// The ordinary lotting draft is a single key. Starting the next item replaces
// it, so "Scan another item" after a rejected admission used to erase the only
// pointer back to lot A and its photos. A created lot's recovery draft is now
// copied to a per-lot key before the screen resets: B can use the main draft
// without overwriting A, and A stays recoverable across a kill or restart.
//
// Every key lives under `lotting:draft:photo:recovery:<lotId>` so the existing
// photo-pruning pass (which scans `lotting:draft:`) also treats those files as
// referenced.

import AsyncStorage from '@react-native-async-storage/async-storage';

export const PHOTO_RECOVERY_PREFIX = 'lotting:draft:photo:recovery:';

export interface RecoveryStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

export interface PhotoRecoveryDraft<T> {
  key: string;
  lotId: string;
  savedAt: number;
  draft: T;
}

/**
 * A read can fail because storage is briefly unavailable. An empty list and a
 * failed read are not the same thing: treating a failure as "no records" hides
 * a lot's only recovery pointer until the screen remounts (RED TEAM #683
 * MEDIUM follow-up, #743).
 */
export type PhotoRecoveryRead<T> =
  | { status: 'ok'; records: PhotoRecoveryDraft<T>[] }
  | { status: 'unavailable' };

export type LatestPhotoRecoveryRead<T> =
  | { status: 'ok'; record: PhotoRecoveryDraft<T> | null }
  | { status: 'unavailable' };

/** Retry delays are capped so a long outage cannot spin the device. */
export const PHOTO_RECOVERY_RETRY_BASE_MS = 1_000;
export const PHOTO_RECOVERY_RETRY_MAX_MS = 30_000;

export function photoRecoveryRetryDelay(retry: number): number {
  const step = Math.max(0, Math.min(Math.floor(retry), 5));
  return Math.min(PHOTO_RECOVERY_RETRY_BASE_MS * 2 ** step, PHOTO_RECOVERY_RETRY_MAX_MS);
}

/** Copy a created-lot draft aside. Keeps the main draft key untouched. */
export async function preservePhotoRecovery<T>(
  storage: RecoveryStorage,
  lotId: string | null | undefined,
  draft: T,
  now = Date.now(),
): Promise<boolean> {
  if (!lotId) return false;
  try {
    await storage.setItem(
      `${PHOTO_RECOVERY_PREFIX}${lotId}`,
      JSON.stringify({ savedAt: now, draft }),
    );
    return true;
  } catch {
    // Best effort: failing to archive must not block the new item.
    return false;
  }
}

/**
 * Read every usable recovery record, distinguishing "none" from "could not
 * read". A transient read failure is reported, never deleted, so the caller
 * can retry without losing the last pointer.
 */
export async function readPhotoRecoveries<T>(
  storage: RecoveryStorage,
): Promise<PhotoRecoveryRead<T>> {
  let keys: readonly string[];
  try {
    keys = await storage.getAllKeys();
  } catch {
    return { status: 'unavailable' };
  }
  const records: PhotoRecoveryDraft<T>[] = [];
  for (const key of keys) {
    if (!key.startsWith(PHOTO_RECOVERY_PREFIX)) continue;
    let raw: string | null;
    try {
      raw = await storage.getItem(key);
    } catch {
      // Do not return a partial list: the unreadable key might be the
      // eligible record, and reporting "no recovery" would bury it.
      return { status: 'unavailable' };
    }
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { savedAt?: unknown; draft?: unknown };
      if (!parsed || typeof parsed !== 'object' || parsed.draft == null) continue;
      records.push({
        key,
        lotId: key.slice(PHOTO_RECOVERY_PREFIX.length),
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
        draft: parsed.draft as T,
      });
    } catch {
      // Leave corrupt records alone: an unreadable record is still better than
      // deleting a lot's only recovery pointer on a bad parse.
    }
  }
  return { status: 'ok', records };
}

/**
 * Every usable recovery record. A transient read failure is skipped, not
 * deleted, so a temporary storage error cannot destroy the last pointer.
 */
export async function listPhotoRecoveries<T>(
  storage: RecoveryStorage,
): Promise<PhotoRecoveryDraft<T>[]> {
  const read = await readPhotoRecoveries<T>(storage);
  return read.status === 'ok' ? read.records : [];
}

function newest<T>(records: PhotoRecoveryDraft<T>[]): PhotoRecoveryDraft<T> {
  return records.reduce((best, record) => (record.savedAt > best.savedAt ? record : best));
}

/** The most recently archived record, if any. */
export async function latestPhotoRecovery<T>(
  storage: RecoveryStorage,
): Promise<PhotoRecoveryDraft<T> | null> {
  const records = await listPhotoRecoveries<T>(storage);
  return records.length === 0 ? null : newest(records);
}

/**
 * The most recent record this operator can recover. Preference is given to the
 * current operator's own records before the newest overall: a newer record
 * captured by a different sign-in must not block an older eligible one (RED
 * TEAM #683 MEDIUM). Foreign records are returned only when nothing belongs to
 * this operator, so the screen can explain the owner mismatch without touching
 * them.
 */
export async function readLatestPhotoRecoveryFor<T extends { operatorId?: string }>(
  storage: RecoveryStorage,
  operatorId: string | null | undefined,
): Promise<LatestPhotoRecoveryRead<T>> {
  const read = await readPhotoRecoveries<T>(storage);
  if (read.status === 'unavailable') return read;
  const records = read.records;
  if (records.length === 0) return { status: 'ok', record: null };
  if (operatorId) {
    const owned = records.filter((record) => record.draft?.operatorId === operatorId);
    if (owned.length > 0) return { status: 'ok', record: newest(owned) };
  }
  return { status: 'ok', record: newest(records) };
}

export async function latestPhotoRecoveryFor<T extends { operatorId?: string }>(
  storage: RecoveryStorage,
  operatorId: string | null | undefined,
): Promise<PhotoRecoveryDraft<T> | null> {
  const read = await readLatestPhotoRecoveryFor<T>(storage, operatorId);
  return read.status === 'ok' ? read.record : null;
}

export interface PhotoRecoveryRetryOptions {
  /** Test seam; defaults to a real timer. */
  wait?: (ms: number) => Promise<void>;
  /** Return false to stop retrying (screen unmounted or effect superseded). */
  shouldContinue?: () => boolean;
}

/**
 * Read the latest recovery, retrying with capped backoff while storage is
 * unavailable. This keeps the recovery offer pending instead of latching it
 * off for the rest of the mount (RED TEAM #683 MEDIUM follow-up, #743).
 *
 * Returns `null` only when `shouldContinue` says to stop; callers must not
 * treat that as "no recovery". Records are never modified here, so another
 * operator's archive stays untouched.
 */
export async function readPhotoRecoveryWithRetry<T extends { operatorId?: string }>(
  storage: RecoveryStorage,
  operatorId: string | null | undefined,
  options: PhotoRecoveryRetryOptions = {},
): Promise<LatestPhotoRecoveryRead<T> | null> {
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const shouldContinue = options.shouldContinue ?? (() => true);
  let retry = 0;
  while (shouldContinue()) {
    const read = await readLatestPhotoRecoveryFor<T>(storage, operatorId);
    if (read.status === 'ok') return read;
    if (!shouldContinue()) return null;
    await wait(photoRecoveryRetryDelay(retry));
    retry += 1;
  }
  return null;
}

/** Remove a recovery record once its photos are attached or it is discarded. */
export async function discardPhotoRecovery(
  storage: RecoveryStorage,
  lotIdOrKey: string | null | undefined,
): Promise<void> {
  if (!lotIdOrKey) return;
  const key = lotIdOrKey.startsWith(PHOTO_RECOVERY_PREFIX)
    ? lotIdOrKey
    : `${PHOTO_RECOVERY_PREFIX}${lotIdOrKey}`;
  try {
    await storage.removeItem(key);
  } catch {
    /* best effort */
  }
}

/** AsyncStorage-backed convenience wrappers for the lotting screens. */
export const photoRecovery = {
  preserve: <T>(lotId: string | null | undefined, draft: T) =>
    preservePhotoRecovery(AsyncStorage, lotId, draft),
  list: <T>() => listPhotoRecoveries<T>(AsyncStorage),
  latest: <T>() => latestPhotoRecovery<T>(AsyncStorage),
  latestFor: <T extends { operatorId?: string }>(operatorId: string | null | undefined) =>
    latestPhotoRecoveryFor<T>(AsyncStorage, operatorId),
  readLatestFor: <T extends { operatorId?: string }>(
    operatorId: string | null | undefined,
    shouldContinue?: () => boolean,
  ) => readPhotoRecoveryWithRetry<T>(AsyncStorage, operatorId, { shouldContinue }),
  discard: (lotId: string | null | undefined) => discardPhotoRecovery(AsyncStorage, lotId),
};
