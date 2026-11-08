import { describe, expect, it } from 'vitest';
import { loadStoredDraft, type DraftStorage } from './draft-storage';

const MAX_AGE_MS = 30 * 60 * 1000;
const NOW = 1_700_000_000_000;
const KEY = 'lotting:draft:photo';

const createdDraft = {
  hero: { uri: 'file:///hero.jpg' },
  conditionPhotos: [{ uri: 'file:///condition.jpg' }],
  editable: { title: 'Lamp' },
  created: { lotId: 'lot-1', lotCode: 'DEV-0001' },
  operatorId: 'op-a',
};

function memoryStorage(initial: string | null) {
  let raw = initial;
  const removed: string[] = [];
  const storage: DraftStorage = {
    async getItem() {
      return raw;
    },
    async removeItem(key: string) {
      removed.push(key);
      raw = null;
    },
  };
  return {
    storage,
    removed,
    get raw() {
      return raw;
    },
  };
}

const retainCreated = (draft: { created?: unknown } | null) => Boolean(draft?.created);

describe('loadStoredDraft', () => {
  it('keeps a created-lot draft past the generic 30-minute window', async () => {
    const stored = JSON.stringify({ savedAt: NOW - MAX_AGE_MS - 60_000, draft: createdDraft });
    const mem = memoryStorage(stored);

    const result = await loadStoredDraft(mem.storage, KEY, {
      maxAgeMs: MAX_AGE_MS,
      now: NOW,
      retainStale: retainCreated,
    });

    expect(result).toEqual({ status: 'draft', draft: createdDraft });
    expect(mem.removed).toEqual([]);
    expect(mem.raw).toBe(stored);
  });

  it('still discards an ordinary stale draft', async () => {
    const ordinary = { hero: null, conditionPhotos: [], editable: { title: 'Lamp' } };
    const mem = memoryStorage(
      JSON.stringify({ savedAt: NOW - MAX_AGE_MS - 60_000, draft: ordinary }),
    );

    const result = await loadStoredDraft(mem.storage, KEY, {
      maxAgeMs: MAX_AGE_MS,
      now: NOW,
      retainStale: retainCreated,
    });

    expect(result).toEqual({ status: 'empty' });
    expect(mem.removed).toEqual([KEY]);
  });

  it('does not delete or overwrite a valid record when a read fails transiently', async () => {
    const stored = JSON.stringify({ savedAt: NOW - 1_000, draft: createdDraft });
    let raw: string | null = stored;
    let reads = 0;
    const removed: string[] = [];
    const storage: DraftStorage = {
      async getItem() {
        reads += 1;
        if (reads === 1) throw new Error('storage busy');
        return raw;
      },
      async removeItem(key: string) {
        removed.push(key);
        raw = null;
      },
    };

    const first = await loadStoredDraft(storage, KEY, { maxAgeMs: MAX_AGE_MS, now: NOW });
    expect(first).toEqual({ status: 'unavailable' });
    expect(removed).toEqual([]);
    expect(raw).toBe(stored);

    const second = await loadStoredDraft(storage, KEY, { maxAgeMs: MAX_AGE_MS, now: NOW });
    expect(second).toEqual({ status: 'draft', draft: createdDraft });
    expect(removed).toEqual([]);
  });

  it('drops only genuinely corrupt JSON', async () => {
    const mem = memoryStorage('{not json');
    const result = await loadStoredDraft(mem.storage, KEY, { maxAgeMs: MAX_AGE_MS, now: NOW });
    expect(result).toEqual({ status: 'empty' });
    expect(mem.removed).toEqual([KEY]);
  });
});
