import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  uploads: 0,
  uploadOk: true,
  patchOk: true,
  writeFails: false,
  readFails: false,
  uploadPaths: [] as string[],
  onUpload: undefined as (() => Promise<void>) | undefined,
  onSetItem: undefined as ((callIndex: number) => Promise<void>) | undefined,
  setItemCalls: 0,
  photoUrls: [] as string[],
  patchMatched: true,
  deletedFiles: [] as string[],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (state.readFails) throw new Error('storage_read_failed');
      return state.store.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      if (state.writeFails) throw new Error('storage_write_failed');
      state.setItemCalls += 1;
      await state.onSetItem?.(state.setItemCalls);
      state.store.set(key, value);
    },
    removeItem: async (key: string) => {
      state.store.delete(key);
    },
  },
}));

vi.mock('@auction-platform/supabase-client', () => ({
  resolveOperatorIdForUpload: async () => 'op-1',
  supabase: {
    rpc: async () => {
      if (!state.patchOk) return { data: null, error: { message: 'patch' } };
      if (!state.patchMatched) {
        return { data: { ok: false, reason: 'not_found' }, error: null };
      }
      return { data: { ok: true, reason: 'appended' }, error: null };
    },
  },
}));

vi.mock('@/lib/upload-image', () => ({
  uploadImageFromUri: async (_bucket: string, path: string) => {
    state.uploads += 1;
    state.uploadPaths.push(path);
    await state.onUpload?.();
    return state.uploadOk
      ? { ok: true, url: `https://cdn.test/photo-${state.uploads}.jpg` }
      : { ok: false, reason: 'offline' };
  },
}));

vi.mock('@/lib/image-compress', () => ({ compressToJpegUri: async (uri: string) => uri }));
vi.mock('@/lib/persist-photo', () => ({
  deletePersistedPhoto: async (uri: string) => {
    state.deletedFiles.push(uri);
  },
  persistedPhotoExists: async () => true,
}));
vi.mock('@/features/lotting/uploadPendingPhotos', () => ({
  isLocalPhotoUri: (uri: string) => !/^https:\/\//i.test(uri),
}));

import {
  drainPhotoQueue,
  enqueuePhotoUpload,
  enqueueLotPhoto,
  listPhotoQueue,
  photoQueueCount,
  photoQueueCountSafe,
  subscribePhotoQueue,
} from './photo-upload-queue';

const input = (uri: string) => ({
  lotId: 'lot-1',
  lotCode: 'DEV-0001',
  operatorId: 'op-1',
  localUri: uri,
});

describe('photo upload queue', () => {
  beforeEach(() => {
    state.store.clear();
    state.uploads = 0;
    state.uploadOk = true;
    state.patchOk = true;
    state.writeFails = false;
    state.readFails = false;
    state.uploadPaths = [];
    state.onUpload = undefined;
    state.onSetItem = undefined;
    state.setItemCalls = 0;
    state.photoUrls = [];
    state.patchMatched = true;
    state.deletedFiles = [];
  });

  it('queues, dedupes and counts by lot', async () => {
    await enqueuePhotoUpload(input('file:///a.jpg'));
    await enqueuePhotoUpload(input('file:///a.jpg'));
    await enqueuePhotoUpload(input('file:///b.jpg'));
    expect(await photoQueueCount('lot-1')).toBe(2);
    expect((await listPhotoQueue()).map((entry) => entry.localUri)).toEqual([
      'file:///a.jpg',
      'file:///b.jpg',
    ]);
  });

  it('uploads, patches the lot and clears the queue', async () => {
    await enqueuePhotoUpload(input('file:///a.jpg'));
    const result = await drainPhotoQueue();
    expect(result.uploaded).toBe(1);
    expect(result.uploadedUrls[0]?.lotId).toBe('lot-1');
    expect(await photoQueueCount('lot-1')).toBe(0);
  });

  it('keeps the photo when upload fails', async () => {
    state.uploadOk = false;
    await enqueuePhotoUpload(input('file:///a.jpg'));
    const result = await drainPhotoQueue();
    expect(result.failed).toBe(1);
    expect(await photoQueueCount('lot-1')).toBe(1);
  });

  it('queues 51 photos without dropping the 51st', async () => {
    for (let i = 0; i < 51; i += 1) {
      expect(await enqueuePhotoUpload(input(`file:///photo-${i}.jpg`))).not.toBeNull();
    }
    expect(await photoQueueCount('lot-1')).toBe(51);
  });

  it('does not report success when storage write fails', async () => {
    state.writeFails = true;
    expect(await enqueuePhotoUpload(input('file:///a.jpg'))).toBeNull();
    state.writeFails = false;
    expect(await photoQueueCount('lot-1')).toBe(0);
  });

  it('keeps a photo added while a drain is running', async () => {
    let added = false;
    state.onUpload = async () => {
      if (added) return;
      added = true;
      await enqueuePhotoUpload(input('file:///new.jpg'));
    };
    await enqueuePhotoUpload(input('file:///a.jpg'));
    await drainPhotoQueue();
    const left = await listPhotoQueue();
    expect(left.map((entry) => entry.localUri)).toContain('file:///new.jpg');
    expect(left.map((entry) => entry.localUri)).not.toContain('file:///a.jpg');
  });

  it('does not lose a photo enqueued between the drain final read and write', async () => {
    let releaseFinalWrite: () => void = () => {};
    const finalWriteGate = new Promise<void>((resolve) => {
      releaseFinalWrite = resolve;
    });
    let finalWriteStarted: () => void = () => {};
    const finalWriteReached = new Promise<void>((resolve) => {
      finalWriteStarted = resolve;
    });
    state.onSetItem = async (callIndex) => {
      // Call 1 is the initial enqueue, 2 persists the uploaded URL, 3 is the
      // upload receipt, 4 is the drain's final reconcile write.
      if (callIndex !== 4) return;
      finalWriteStarted();
      await finalWriteGate;
    };

    await enqueuePhotoUpload(input('file:///a.jpg'));
    const drain = drainPhotoQueue();
    await finalWriteReached;

    const second = enqueuePhotoUpload(input('file:///new.jpg'));
    // Let the enqueue reach storage while the final write is paused. With the
    // old split tails it wrote over the drain snapshot and was then erased.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    releaseFinalWrite();
    await drain;
    expect(await second).not.toBeNull();

    const left = await listPhotoQueue();
    expect(left.map((entry) => entry.localUri)).toContain('file:///new.jpg');
    expect(left.map((entry) => entry.localUri)).not.toContain('file:///a.jpg');
  });

  it('keeps the accepted queue when a storage read fails transiently', async () => {
    await enqueuePhotoUpload(input('file:///a.jpg'));
    state.readFails = true;

    await expect(drainPhotoQueue()).rejects.toThrow('photo_queue_read_failed');
    expect(await enqueuePhotoUpload(input('file:///b.jpg'))).toBeNull();

    state.readFails = false;
    const left = await listPhotoQueue();
    expect(left.map((entry) => entry.localUri)).toEqual(['file:///a.jpg']);
  });

  it('never deletes a stale pending photo or drops it from the queue', async () => {
    state.uploadOk = false;
    await enqueuePhotoUpload(input('file:///old.jpg'));
    const raw = JSON.parse(state.store.get('lotting:photo-upload-queue:v1') ?? '[]');
    raw[0].createdAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    state.store.set('lotting:photo-upload-queue:v1', JSON.stringify(raw));

    const stale = await drainPhotoQueue();
    expect(stale.failed).toBe(1);
    expect(await photoQueueCount('lot-1')).toBe(1);

    state.uploadOk = true;
    const recovered = await drainPhotoQueue();
    expect(recovered.uploaded).toBe(1);
    expect(await photoQueueCount('lot-1')).toBe(0);
  });

  it('uploads under the operator the photo was queued for after a switch', async () => {
    await enqueuePhotoUpload({ ...input('file:///a.jpg'), operatorId: 'op-original' });
    const drained = await drainPhotoQueue();
    expect(drained.uploaded).toBe(1);
    expect(state.uploadPaths[0]?.startsWith('op-original/')).toBe(true);
    expect(state.uploadPaths[0]?.startsWith('op-1/')).toBe(false);
  });

  it('keeps the photo when the append matches no row', async () => {
    state.patchMatched = false;
    await enqueuePhotoUpload(input('file:///a.jpg'));
    const result = await drainPhotoQueue();
    expect(result.failed).toBe(1);
    expect(await photoQueueCount('lot-1')).toBe(1);
    expect(state.deletedFiles).not.toContain('file:///a.jpg');
  });

  it('reports the last known count when the storage read fails', async () => {
    await enqueuePhotoUpload(input('file:///a.jpg'));
    expect(await photoQueueCountSafe('lot-1')).toBe(1);
    state.readFails = true;
    expect(await photoQueueCountSafe('lot-1')).toBe(1);
    expect(await enqueueLotPhoto(input('file:///b.jpg'))).toMatchObject({
      id: null,
      status: 'error',
    });
  });

  it('notifies subscribers when the queue changes', async () => {
    let calls = 0;
    const stop = subscribePhotoQueue(() => {
      calls += 1;
    });
    await enqueuePhotoUpload(input('file:///a.jpg'));
    await drainPhotoQueue();
    stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('retries only the patch after an upload succeeded', async () => {
    state.patchOk = false;
    await enqueuePhotoUpload(input('file:///a.jpg'));
    await drainPhotoQueue();
    expect(state.uploads).toBe(1);
    expect(await photoQueueCount('lot-1')).toBe(1);

    state.patchOk = true;
    const second = await drainPhotoQueue();
    expect(second.uploaded).toBe(1);
    expect(state.uploads).toBe(1);
    expect(await photoQueueCount('lot-1')).toBe(0);
  });
});
