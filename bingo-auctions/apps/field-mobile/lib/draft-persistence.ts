/**
 * The persistence core shared by the lotting screen's `useDraftPersistence`
 * hook and its tests.
 *
 * `useDraftPersistence` used to call the storage helpers directly, so a test
 * that wrote through `writeStoredDraft` could still pass while the hook's own
 * save was neutered or disconnected (RED TEAM #762). Both paths now go through
 * this controller: the hook adds the debounce/AppState timers, the controller
 * owns what a save, restore and clear actually do.
 */
import {
  loadStoredDraft,
  writeStoredDraft,
  type DraftLoadResult,
  type DraftStorage,
  type DraftWriteStorage,
} from './draft-storage';

export interface DraftPersistenceOptions<T> {
  /** Older than this and an ordinary draft is discarded. */
  maxAgeMs?: number;
  /** Keep a draft past `maxAgeMs` (created-lot recovery drafts). */
  retainStored?: (draft: T) => boolean;
  /** Delete a local file that belongs to a cleared draft. */
  deleteFile?: (uri: string) => void | Promise<void>;
}

export interface DraftPersistence<T> {
  readonly key: string;
  write(draft: T | null): Promise<void>;
  loadDraft(): Promise<DraftLoadResult<T>>;
  load(): Promise<T | null>;
  clear(previous: T | null): Promise<void>;
}

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

export function createDraftPersistence<T>(
  storage: DraftStorage & DraftWriteStorage,
  key: string,
  options: DraftPersistenceOptions<T> = {},
): DraftPersistence<T> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const deleteFile = options.deleteFile ?? (() => {});

  /**
   * Every key operation goes through one queue in call order. `clear` is
   * fire-and-forget from the hook, and its file cleanup can take arbitrarily
   * long, so the key removal must be ordered with — not after — a save that
   * starts while cleanup is still running. Otherwise the old item's cleanup
   * deletes the next item's freshly saved draft (RED TEAM HIGH on #755).
   *
   * Reads are queued too: a read can delete an expired or corrupt record, so a
   * read that captured the old value before a save and deleted after it would
   * erase the next draft. The whole read-and-cleanup has to be atomic with
   * writes (RED TEAM MEDIUM #763).
   */
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <V>(operation: () => Promise<V>): Promise<V> => {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  };

  const write = (draft: T | null) => serial(() => writeStoredDraft(storage, key, draft));

  /** The raw read; callers must hold the queue (see `loadDraft`/`load`). */
  const readDraft = () =>
    loadStoredDraft<T>(storage, key, {
      maxAgeMs,
      retainStale: options.retainStored,
    });

  const loadDraft = () => serial(readDraft);

  /** Read a recent draft; a transient failure gets one immediate retry. */
  const load = () =>
    serial(async () => {
      let result = await readDraft();
      if (result.status === 'unavailable') result = await readDraft();
      return result.status === 'draft' ? result.draft : null;
    });

  const clear = async (previous: T | null): Promise<void> => {
    // Remove the key before any awaited file cleanup. The hook does not await
    // `clear`, so an awaited delete let a newer draft be saved first and then
    // removed by this stale clear. The key removal is ordered with writes in
    // this controller; a save that starts after the clear re-creates the key,
    // and a save that started before it was queued first.
    try {
      await serial(() => storage.removeItem(key));
    } catch {
      /* best effort: a failed remove must never block the screen */
    }
    if (!previous) return;
    // File cleanup happens outside the queue: a slow or hung delete must not
    // hold up the next item's save.
    let uris: string[];
    try {
      uris = [...JSON.stringify(previous).matchAll(/file:\/\/\/[^"\\]+/g)].map((match) => match[0]);
    } catch {
      return;
    }
    for (const uri of uris) {
      try {
        await deleteFile(uri);
      } catch {
        /* best effort: a failed delete must never block the screen */
      }
    }
  };

  return { key, write, loadDraft, load, clear };
}
