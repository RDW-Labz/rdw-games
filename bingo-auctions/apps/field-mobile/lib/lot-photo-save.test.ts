import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  files: new Set<string>(),
  uploads: 0,
  successes: 0,
  uploadOk: true,
  failUris: new Set<string>(),
  writeFails: false,
  photoUrls: [] as string[],
  stallUploads: false,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => state.store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (state.writeFails) throw new Error('storage_write_failed');
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
    rpc: async () => ({ data: { ok: true, reason: 'appended' }, error: null }),
  },
}));

vi.mock('@/lib/upload-image', () => ({
  uploadImageFromUri: async (_bucket: string, _path: string, uri: string) => {
    state.uploads += 1;
    if (state.stallUploads) await new Promise(() => {});
    const ok = state.uploadOk && !state.failUris.has(uri);
    if (ok) state.successes += 1;
    return ok
      ? { ok: true, url: `https://cdn.test/photo-${state.uploads}.jpg` }
      : { ok: false, reason: 'offline' };
  },
}));

vi.mock('@/lib/image-compress', () => ({ compressToJpegUri: async (uri: string) => uri }));
vi.mock('@/features/lotting/uploadPendingPhotos', () => ({
  isLocalPhotoUri: (uri: string) => !/^https:\/\//i.test(uri),
}));
vi.mock('@/lib/persist-photo', () => ({
  deletePersistedPhoto: async (uri: string) => {
    state.files.delete(uri);
  },
  persistedPhotoExists: async (uri: string) => state.files.has(uri),
}));

import { queueAndDrainLotPhotos } from './lot-photo-save';
import { drainPhotoQueue, listPhotoQueue } from './photo-upload-queue';

const hero = 'file:///hero.jpg';
const condition = 'file:///condition.jpg';
const stock = 'file:///stock.jpg';

const photos = [
  { kind: 'hero' as const, uri: hero },
  { kind: 'condition' as const, uri: condition },
  { kind: 'stock' as const, uri: stock },
];

const run = (list = photos) =>
  queueAndDrainLotPhotos({
    lotId: 'lot-1',
    lotCode: 'DEV-0001',
    operatorId: 'op-1',
    photos: list,
    remoteStockCount: 2,
  });

// Let the background drain (queued by run) finish before asserting storage.
const settle = async () => {
  await drainPhotoQueue();
  await drainPhotoQueue();
};

describe('lot photo save resume', () => {
  beforeEach(async () => {
    // Flush any drain tail left by the previous case before wiping storage,
    // otherwise its trailing write lands after this clear and the next case
    // starts with a phantom entry.
    await drainPhotoQueue().catch(() => {});
    state.store.clear();
    state.files = new Set([hero, condition, stock]);
    state.uploads = 0;
    state.successes = 0;
    state.uploadOk = true;
    state.failUris.clear();
    state.writeFails = false;
    state.photoUrls = [];
    state.stallUploads = false;
  });

  it('reports a photo that never queued so the draft is kept', async () => {
    state.writeFails = true;
    const outcome = await run();
    expect(outcome.remaining).toBe(3);
    expect(outcome.unresolved).toBe(3);
    expect(outcome.unresolvedPhotos.map((photo) => photo.uri)).toEqual([hero, condition, stock]);
    expect(outcome.unresolvedPhotos.map((photo) => photo.kind)).toEqual([
      'hero',
      'condition',
      'stock',
    ]);
    expect(outcome.heroOk).toBe(false);
    expect(outcome.stockDropped).toBe(1);
    expect(await listPhotoQueue()).toHaveLength(0);
  });

  it('resumes a kill during upload without creating another lot', async () => {
    state.uploadOk = false;
    const first = await run();
    await settle();
    expect(first.remaining).toBe(3);
    expect(await listPhotoQueue()).toHaveLength(3);

    // New process: the queue is read from storage, not module memory.
    state.uploadOk = true;
    const resumed = await run();
    await settle();
    expect(resumed.remaining).toBe(3);
    expect(await listPhotoQueue()).toHaveLength(0);
    expect(resumed.heroOk).toBe(true);
    expect(resumed.conditionsOk).toBe(1);
    expect(resumed.stockDropped).toBe(0);
    expect(resumed.stockCount).toBe(3);
    expect(state.successes).toBe(3);
  });

  it('reports a never-uploaded hero whose file is gone instead of claiming success', async () => {
    // The capture persisted this file, then it disappeared before it ever
    // reached the queue. There is no receipt, so it was never attached.
    state.files.delete(hero);
    const outcome = await run([{ kind: 'hero' as const, uri: hero }]);
    expect(outcome.heroOk).toBe(false);
    expect(outcome.remaining).toBe(1);
    expect(await listPhotoQueue()).toHaveLength(0);
    expect(state.successes).toBe(0);
  });

  it('does not re-queue an already uploaded photo whose file was deleted', async () => {
    // Stock and hero upload; the condition photo fails (offline).
    state.failUris.add(condition);
    const first = await run();
    await settle();
    expect(first.heroOk).toBe(true);
    expect(first.stockDropped).toBe(0);
    expect(first.conditionsOk).toBe(1);
    expect(first.remaining).toBe(3);
    expect(state.files.has(hero)).toBe(false);
    expect(state.files.has(stock)).toBe(false);
    expect(await listPhotoQueue()).toHaveLength(1);

    // Retry passes the whole photo list again, including the deleted copies.
    state.failUris.clear();
    const resumed = await run();
    await settle();
    expect(resumed.remaining).toBe(1);
    expect(resumed.heroOk).toBe(true);
    expect(resumed.conditionsOk).toBe(1);
    expect(resumed.stockDropped).toBe(0);
    expect(await listPhotoQueue()).toHaveLength(0);
    // Hero and stock were attached on the first pass; only the failed
    // condition should upload on the retry.
    expect(state.successes).toBe(3);
  });

  it('keeps only the rejected photo in the unresolved list while the rest upload', async () => {
    // The condition file disappeared before it reached the queue, so it is
    // never accepted; hero and stock still queue and drain.
    state.files.delete(condition);

    const outcome = await run();

    expect(outcome.heroOk).toBe(true);
    expect(outcome.conditionsOk).toBe(0);
    // Two are durably queued and one never queued; `remaining` reports both.
    expect(outcome.remaining).toBe(3);
    expect(outcome.unresolved).toBe(1);
    expect(outcome.unresolvedPhotos).toEqual([{ kind: 'condition', uri: condition }]);

    await settle();
    expect(await listPhotoQueue()).toHaveLength(0);
    expect(state.successes).toBe(2);
  });

  // Last test: it deliberately leaves the shared drain tail pending, so no
  // later case in this file may await the queue again.
  it('returns immediately after durable storage while an upload is stalled', async () => {
    state.stallUploads = true;
    const outcome = await run();
    // No timer is advanced and the upload never resolves: the save screen is
    // usable because the photos are already durably queued.
    expect(outcome.heroOk).toBe(true);
    expect(outcome.conditionsOk).toBe(1);
    expect(outcome.remaining).toBe(3);
    expect(await listPhotoQueue()).toHaveLength(3);
  });
});
