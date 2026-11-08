import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ readFails: true }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => {
      if (state.readFails) throw new Error('storage_read_failed');
      return null;
    },
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

vi.mock('@auction-platform/supabase-client', () => ({
  resolveOperatorIdForUpload: async () => 'op-1',
  supabase: { rpc: async () => ({ data: { ok: true }, error: null }) },
}));

vi.mock('@/lib/upload-image', () => ({
  uploadImageFromUri: async () => ({ ok: true, url: 'https://cdn.test/x.jpg' }),
}));
vi.mock('@/lib/image-compress', () => ({ compressToJpegUri: async (uri: string) => uri }));
vi.mock('@/lib/persist-photo', () => ({
  deletePersistedPhoto: async () => {},
  persistedPhotoExists: async () => true,
}));
vi.mock('@/features/lotting/uploadPendingPhotos', () => ({
  isLocalPhotoUri: (uri: string) => !/^https:\/\//i.test(uri),
}));

import { photoQueueCountSafe } from './photo-upload-queue';

describe('photoQueueCountSafe on a cold launch', () => {
  it('reports unknown instead of zero when the first read fails', async () => {
    expect(await photoQueueCountSafe()).toBeNull();
    expect(await photoQueueCountSafe('lot-1')).toBeNull();
  });
});
