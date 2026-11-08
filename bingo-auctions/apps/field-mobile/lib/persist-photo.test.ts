import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  copyAsync: vi.fn(),
  makeDirectoryAsync: vi.fn(),
  getInfoAsync: vi.fn(),
  readDirectoryAsync: vi.fn(),
  deleteAsync: vi.fn(),
}));

const store = vi.hoisted(() => ({
  data: new Map<string, string>(),
  readFails: false,
}));

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  copyAsync: fs.copyAsync,
  makeDirectoryAsync: fs.makeDirectoryAsync,
  getInfoAsync: fs.getInfoAsync,
  readDirectoryAsync: fs.readDirectoryAsync,
  deleteAsync: fs.deleteAsync,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (store.readFails) throw new Error('storage_read_failed');
      return store.data.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      store.data.set(key, value);
    },
    getAllKeys: async () => [...store.data.keys()],
    multiGet: async (keys: string[]) => keys.map((key) => [key, store.data.get(key) ?? null]),
  },
}));

vi.mock('@/features/lotting/uploadPendingPhotos', () => ({
  isLocalPhotoUri: (uri: string) => !/^https:\/\//i.test(uri),
}));

import { persistPhoto, prunePersistedPhotos } from './persist-photo';

const DAY = 24 * 60 * 60 * 1000;
const oldSeconds = 1_600_000_000;
const now = oldSeconds * 1000 + 30 * DAY;

describe('persistPhoto', () => {
  beforeEach(() => {
    fs.copyAsync.mockReset().mockResolvedValue(undefined);
    fs.makeDirectoryAsync.mockReset().mockResolvedValue(undefined);
    fs.getInfoAsync.mockReset();
    fs.readDirectoryAsync.mockReset();
    fs.deleteAsync.mockReset().mockResolvedValue(undefined);
    store.data.clear();
    store.readFails = false;
  });

  it('copies a local photo into Documents', async () => {
    const out = await persistPhoto('file:///cache/IMG_1.jpg');
    expect(fs.makeDirectoryAsync).toHaveBeenCalledWith('file:///docs/lot-photos/', {
      intermediates: true,
    });
    expect(fs.copyAsync).toHaveBeenCalledWith({
      from: 'file:///cache/IMG_1.jpg',
      to: expect.stringMatching(/^file:\/\/\/docs\/lot-photos\/.+\.jpg$/),
    });
    expect(out).toMatch(/^file:\/\/\/docs\/lot-photos\/.+\.jpg$/);
  });

  it('leaves a remote URL unchanged', async () => {
    expect(await persistPhoto('https://cdn.example/x.jpg')).toBe('https://cdn.example/x.jpg');
    expect(fs.copyAsync).not.toHaveBeenCalled();
  });

  it('returns the original if the copy fails', async () => {
    fs.copyAsync.mockRejectedValue(new Error('disk'));
    expect(await persistPhoto('file:///cache/IMG_2.jpg')).toBe('file:///cache/IMG_2.jpg');
  });
});

describe('prunePersistedPhotos', () => {
  const queueKey = 'lotting:photo-upload-queue:v1';

  beforeEach(() => {
    fs.getInfoAsync.mockReset();
    fs.readDirectoryAsync.mockReset();
    fs.deleteAsync.mockReset().mockResolvedValue(undefined);
    store.data.clear();
    store.readFails = false;
    fs.getInfoAsync.mockImplementation(async (uri: string) =>
      uri === 'file:///docs/lot-photos/'
        ? { exists: true, isDirectory: true }
        : { exists: true, isDirectory: false, modificationTime: oldSeconds },
    );
    fs.readDirectoryAsync.mockResolvedValue([]);
  });

  it('keeps an old photo that the upload queue still references', async () => {
    const uri = 'file:///docs/lot-photos/queued-old.jpg';
    fs.readDirectoryAsync.mockResolvedValue(['queued-old.jpg']);
    store.data.set(
      queueKey,
      JSON.stringify([
        {
          id: 'q1',
          lotId: 'lot-1',
          lotCode: 'DEV-0001',
          operatorId: 'op-1',
          localUri: uri,
          createdAt: oldSeconds * 1000,
          attempts: 0,
          uploadedUrl: null,
        },
      ]),
    );

    await prunePersistedPhotos(now);

    expect(fs.deleteAsync).not.toHaveBeenCalled();
    expect(JSON.parse(store.data.get(queueKey) ?? '[]')).toHaveLength(1);
  });

  it('keeps files when the queue cannot be read', async () => {
    fs.readDirectoryAsync.mockResolvedValue(['orphan.jpg']);
    store.readFails = true;

    await prunePersistedPhotos(now);

    expect(fs.deleteAsync).not.toHaveBeenCalled();
  });

  it('keeps files when the queue JSON is corrupt', async () => {
    fs.readDirectoryAsync.mockResolvedValue(['orphan.jpg']);
    store.data.set(queueKey, '{not json');

    await prunePersistedPhotos(now);

    expect(fs.deleteAsync).not.toHaveBeenCalled();
  });

  it('still deletes an old file nothing references', async () => {
    fs.readDirectoryAsync.mockResolvedValue(['orphan.jpg']);

    await prunePersistedPhotos(now);

    expect(fs.deleteAsync).toHaveBeenCalledWith('file:///docs/lot-photos/orphan.jpg', {
      idempotent: true,
    });
  });

  it('keeps an old file a saved draft references', async () => {
    const uri = 'file:///docs/lot-photos/draft.jpg';
    fs.readDirectoryAsync.mockResolvedValue(['draft.jpg']);
    store.data.set(
      'lotting:draft:lot-1',
      JSON.stringify({ draft: { hero: { uri }, editable: { stockPhotos: [uri] } } }),
    );

    await prunePersistedPhotos(now);

    expect(fs.deleteAsync).not.toHaveBeenCalled();
  });
});
