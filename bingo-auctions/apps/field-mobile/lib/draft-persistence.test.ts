import { describe, expect, it } from 'vitest';
import { createDraftPersistence } from './draft-persistence';
import { writeStoredDraft } from './draft-storage';

/**
 * RED TEAM #755 HIGH: `clear` used to await local file deletion before it
 * removed the shared draft key. The hook calls `clear` without awaiting it, so
 * an old item's slow cleanup could run after the next item had already been
 * saved — and then delete that newer draft. These cases hold, fail and stall
 * the cleanup for both lotting keys and require the next draft to survive.
 */

interface Draft {
  id: string;
  hero: string;
}

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const KEYS = ['lotting:draft:photo', 'lotting:draft:lot'] as const;

const oldDraft: Draft = { id: 'old', hero: 'file:///old-item.jpg' };
const nextDraft: Draft = { id: 'next', hero: 'file:///next-item.jpg' };

describe.each(KEYS)('draft persistence clear races on %s', (key) => {
  it('does not delete a draft saved while the old cleanup is held', async () => {
    const storage = memoryStorage();
    const gate = deferred();
    const deleted: string[] = [];
    const persistence = createDraftPersistence<Draft>(storage, key, {
      deleteFile: async (uri) => {
        if (uri === oldDraft.hero) await gate.promise;
        deleted.push(uri);
      },
    });

    await persistence.write(oldDraft);
    const clearing = persistence.clear(oldDraft);

    // The next item is saved and flushed while the old cleanup is still held.
    await persistence.write(nextDraft);
    expect(await persistence.load()).toEqual(nextDraft);

    gate.resolve();
    await clearing;

    // The stale clear finished but must not have removed the newer draft.
    expect(await persistence.load()).toEqual(nextDraft);
    expect(deleted).toEqual([oldDraft.hero]);
  });

  it('keeps the newer draft when the old cleanup fails', async () => {
    const storage = memoryStorage();
    const gate = deferred();
    const persistence = createDraftPersistence<Draft>(storage, key, {
      deleteFile: async (uri) => {
        if (uri === oldDraft.hero) await gate.promise;
        throw new Error('file is gone');
      },
    });

    await persistence.write(oldDraft);
    const clearing = persistence.clear(oldDraft);
    await persistence.write(nextDraft);

    gate.resolve();
    await clearing;

    expect(await persistence.load()).toEqual(nextDraft);
  });

  it('does not let a stalled cleanup block or delete the newer draft', async () => {
    const storage = memoryStorage();
    const gate = deferred();
    const persistence = createDraftPersistence<Draft>(storage, key, {
      deleteFile: async () => gate.promise,
    });

    await persistence.write(oldDraft);
    const clearing = persistence.clear(oldDraft);

    // The save must complete even though the old delete never resolves.
    await persistence.write(nextDraft);
    expect(await persistence.load()).toEqual(nextDraft);

    gate.resolve();
    await clearing;
    expect(await persistence.load()).toEqual(nextDraft);
  });
});

/**
 * RED TEAM #763 MEDIUM: `loadDraft` used to run outside the queue even though
 * `loadStoredDraft` deletes an expired or corrupt record. A read that captured
 * the old value before a save, then deleted after it, erased the newer draft.
 * These cases hold the read open across a queued save and require that save to
 * survive the cleanup.
 */
function gatedReadStorage() {
  const store = new Map<string, string>();
  const readStarted = deferred();
  const release = deferred();
  return {
    store,
    readStarted,
    release,
    getItem: async (key: string) => {
      const value = store.get(key) ?? null;
      if (value !== null) {
        readStarted.resolve();
        await release.promise;
      }
      return value;
    },
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
  };
}

describe.each(KEYS)('draft persistence read/cleanup races on %s', (key) => {
  it('does not let an expired read delete a draft saved while it was reading', async () => {
    const storage = gatedReadStorage();
    storage.store.set(
      key,
      JSON.stringify({ savedAt: Date.now() - 2 * 60 * 1000, draft: oldDraft }),
    );
    const persistence = createDraftPersistence<Draft>(storage, key, { maxAgeMs: 60 * 1000 });

    const loading = persistence.load();
    await storage.readStarted.promise;
    const saving = persistence.write(nextDraft);

    storage.release.resolve();
    await Promise.all([loading, saving]);

    expect(JSON.parse(storage.store.get(key) ?? '{}').draft).toEqual(nextDraft);
    expect(await persistence.load()).toEqual(nextDraft);
  });

  it('does not let a corrupt read delete a draft saved while it was reading', async () => {
    const storage = gatedReadStorage();
    storage.store.set(key, '{not json');
    const persistence = createDraftPersistence<Draft>(storage, key);

    const loading = persistence.load();
    await storage.readStarted.promise;
    const saving = persistence.write(nextDraft);

    storage.release.resolve();
    await Promise.all([loading, saving]);

    expect(JSON.parse(storage.store.get(key) ?? '{}').draft).toEqual(nextDraft);
    expect(await persistence.load()).toEqual(nextDraft);
  });
});

describe('draft persistence clear without a previous draft', () => {
  it('removes the key and deletes no files', async () => {
    const storage = memoryStorage();
    const deleted: string[] = [];
    const persistence = createDraftPersistence<Draft>(storage, 'lotting:draft:photo', {
      deleteFile: async (uri) => {
        deleted.push(uri);
      },
    });

    await writeStoredDraft(storage, 'lotting:draft:photo', oldDraft);
    await persistence.clear(null);

    expect(storage.store.has('lotting:draft:photo')).toBe(false);
    expect(deleted).toEqual([]);
  });
});
