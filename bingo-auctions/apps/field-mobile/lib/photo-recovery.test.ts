import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PHOTO_RECOVERY_PREFIX,
  PHOTO_RECOVERY_RETRY_BASE_MS,
  PHOTO_RECOVERY_RETRY_MAX_MS,
  discardPhotoRecovery,
  latestPhotoRecovery,
  latestPhotoRecoveryFor,
  listPhotoRecoveries,
  photoRecoveryRetryDelay,
  preservePhotoRecovery,
  readLatestPhotoRecoveryFor,
  readPhotoRecoveries,
  readPhotoRecoveryWithRetry,
  type RecoveryStorage,
} from './photo-recovery';

function memoryStorage() {
  const data = new Map<string, string>();
  const failReads = { value: false };
  const storage: RecoveryStorage = {
    getItem: async (key) => {
      if (failReads.value) throw new Error('storage_read_failed');
      return data.get(key) ?? null;
    },
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
    getAllKeys: async () => [...data.keys()],
  };
  return { data, failReads, storage };
}

const DRAFT_A = { created: { lotId: 'lot-a', lotCode: 'A-1' }, photos: ['file:///a.jpg'] };
const DRAFT_B = { editable: { title: 'B' }, photos: ['file:///b.jpg'] };

describe('photo recovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('archives a created-lot draft under its own key without touching the live draft', async () => {
    const { data, storage } = memoryStorage();
    data.set('lotting:draft:photo', JSON.stringify({ savedAt: 1, draft: DRAFT_B }));

    expect(await preservePhotoRecovery(storage, 'lot-a', DRAFT_A, 100)).toBe(true);

    expect(data.get(`${PHOTO_RECOVERY_PREFIX}lot-a`)).toContain('lot-a');
    // The item being worked on now (B) must not be overwritten by archiving A.
    expect(JSON.parse(data.get('lotting:draft:photo')!).draft).toEqual(DRAFT_B);
  });

  it('lists recoveries and returns the most recent one', async () => {
    const { storage } = memoryStorage();
    await preservePhotoRecovery(storage, 'old', { ...DRAFT_A, n: 1 }, 100);
    await preservePhotoRecovery(storage, 'new', { ...DRAFT_A, n: 2 }, 200);

    const all = await listPhotoRecoveries(storage);
    expect(all.map((r) => r.lotId).sort()).toEqual(['new', 'old']);
    expect((await latestPhotoRecovery(storage))?.lotId).toBe('new');
  });

  it('leaves a record in place on a transient read failure', async () => {
    const { data, failReads, storage } = memoryStorage();
    await preservePhotoRecovery(storage, 'lot-a', DRAFT_A, 100);
    failReads.value = true;

    expect(await latestPhotoRecovery(storage)).toBeNull();
    expect(data.has(`${PHOTO_RECOVERY_PREFIX}lot-a`)).toBe(true);

    failReads.value = false;
    expect((await latestPhotoRecovery(storage))?.draft).toEqual(DRAFT_A);
  });

  it('discards by lot id or by key and ignores unrelated keys', async () => {
    const { data, storage } = memoryStorage();
    data.set('lotting:draft:quick', JSON.stringify({ savedAt: 1, draft: DRAFT_B }));
    await preservePhotoRecovery(storage, 'lot-a', DRAFT_A, 100);
    await preservePhotoRecovery(storage, 'lot-c', DRAFT_A, 100);

    await discardPhotoRecovery(storage, 'lot-a');
    await discardPhotoRecovery(storage, `${PHOTO_RECOVERY_PREFIX}lot-c`);

    expect(data.has(`${PHOTO_RECOVERY_PREFIX}lot-a`)).toBe(false);
    expect(data.has(`${PHOTO_RECOVERY_PREFIX}lot-c`)).toBe(false);
    // Unrelated drafts are not recoveries and must not be deleted.
    expect(data.has('lotting:draft:quick')).toBe(true);
  });

  it('keeps an unreadable record rather than deleting the only pointer', async () => {
    const { data, storage } = memoryStorage();
    data.set(`${PHOTO_RECOVERY_PREFIX}lot-a`, 'not json');

    expect(await listPhotoRecoveries(storage)).toEqual([]);
    expect(data.has(`${PHOTO_RECOVERY_PREFIX}lot-a`)).toBe(true);
  });

  it('reports a failed archive so the caller can keep the item open', async () => {
    const { data, storage } = memoryStorage();
    storage.setItem = async () => {
      throw new Error('storage_full');
    };
    expect(await preservePhotoRecovery(storage, 'lot-a', DRAFT_A)).toBe(false);
    expect(data.size).toBe(0);
  });

  it('prefers the current operator over a newer foreign record', async () => {
    const { storage } = memoryStorage();
    const owned = { ...DRAFT_A, operatorId: 'operator-a' };
    const foreign = { ...DRAFT_B, operatorId: 'operator-b' };
    await preservePhotoRecovery(storage, 'lot-a', owned, 100);
    await preservePhotoRecovery(storage, 'lot-b', foreign, 200);

    expect((await latestPhotoRecoveryFor(storage, 'operator-a'))?.lotId).toBe('lot-a');
    expect((await latestPhotoRecoveryFor(storage, 'operator-b'))?.lotId).toBe('lot-b');
    // With no owner resolved, the newest record is used only to explain the
    // block; it is never deleted.
    expect((await latestPhotoRecoveryFor(storage, undefined))?.lotId).toBe('lot-b');
  });

  it('does nothing without a lot id', async () => {
    const { data, storage } = memoryStorage();
    expect(await preservePhotoRecovery(storage, null, DRAFT_A)).toBe(false);
    expect(data.size).toBe(0);
  });

  it('distinguishes an empty archive from an unreadable one', async () => {
    const { failReads, storage } = memoryStorage();
    expect(await readPhotoRecoveries(storage)).toEqual({ status: 'ok', records: [] });

    await preservePhotoRecovery(storage, 'lot-a', DRAFT_A, 100);
    failReads.value = true;
    expect(await readPhotoRecoveries(storage)).toEqual({ status: 'unavailable' });
  });

  it('reports unavailable when the key scan itself fails', async () => {
    const { storage } = memoryStorage();
    storage.getAllKeys = async () => {
      throw new Error('storage_busy');
    };
    expect(await readPhotoRecoveries(storage)).toEqual({ status: 'unavailable' });
    expect(await readLatestPhotoRecoveryFor(storage, 'operator-a')).toEqual({
      status: 'unavailable',
    });
  });

  it('does not return a partial list when one record cannot be read', async () => {
    const { data, storage } = memoryStorage();
    await preservePhotoRecovery(storage, 'lot-a', DRAFT_A, 100);
    storage.getItem = async () => {
      throw new Error('storage_busy');
    };

    expect(await readPhotoRecoveries(storage)).toEqual({ status: 'unavailable' });
    expect(data.has(`${PHOTO_RECOVERY_PREFIX}lot-a`)).toBe(true);
  });

  it('backs off with a cap', () => {
    expect(photoRecoveryRetryDelay(0)).toBe(PHOTO_RECOVERY_RETRY_BASE_MS);
    expect(photoRecoveryRetryDelay(1)).toBe(PHOTO_RECOVERY_RETRY_BASE_MS * 2);
    expect(photoRecoveryRetryDelay(20)).toBe(PHOTO_RECOVERY_RETRY_MAX_MS);
  });

  it('recovers automatically after a failed archive read, without touching foreigners', async () => {
    const { data, storage } = memoryStorage();
    const owned = { ...DRAFT_A, operatorId: 'operator-a' };
    const foreign = { ...DRAFT_B, operatorId: 'operator-b' };
    await preservePhotoRecovery(storage, 'lot-a', owned, 100);
    await preservePhotoRecovery(storage, 'lot-b', foreign, 200);

    const originalGet = storage.getItem;
    let reads = 0;
    storage.getItem = async (key) => {
      reads += 1;
      if (reads === 1) throw new Error('storage_busy');
      return originalGet(key);
    };

    const waits: number[] = [];
    const read = await readPhotoRecoveryWithRetry<{ operatorId?: string }>(storage, 'operator-a', {
      wait: async (ms) => {
        waits.push(ms);
      },
      shouldContinue: () => true,
    });

    expect(waits).toEqual([PHOTO_RECOVERY_RETRY_BASE_MS]);
    expect(read?.status).toBe('ok');
    expect(read?.status === 'ok' ? read.record?.lotId : null).toBe('lot-a');
    // A retry must never delete or rewrite the other operator's archive.
    expect(data.has(`${PHOTO_RECOVERY_PREFIX}lot-b`)).toBe(true);
    expect(JSON.parse(data.get(`${PHOTO_RECOVERY_PREFIX}lot-b`)!).draft.operatorId).toBe(
      'operator-b',
    );
  });

  it('returns null only when a retry is cancelled, not for an empty archive', async () => {
    const { failReads, storage } = memoryStorage();
    failReads.value = true;
    expect(
      await readPhotoRecoveryWithRetry(storage, undefined, {
        wait: async () => {},
        shouldContinue: () => false,
      }),
    ).toBeNull();
  });
});
