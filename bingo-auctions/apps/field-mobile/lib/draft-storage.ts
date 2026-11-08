/**
 * Reading a persisted lotting draft.
 *
 * Two failure modes made the generic reader lose work (RED TEAM #683 HIGH):
 *
 * 1. A created lot's recovery draft is the only pointer to photos that never
 *    reached the durable queue, so it must outlive the ordinary 30-minute
 *    in-progress window. `retainStale` lets a caller keep those drafts.
 * 2. A transient storage read exception is not corruption. The old reader
 *    treated both the same and removed the record, making the loss permanent.
 *    A read failure now returns `unavailable` and leaves storage untouched, so
 *    the next read can still recover the lot and its photo references.
 *
 * Only genuinely unparseable / shapeless records are dropped.
 */
export interface DraftStorage {
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
}

export interface DraftWriteStorage {
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * The single write path for a persisted draft, shared by the screen's
 * `useDraftPersistence` hook and its tests. A null draft removes the key
 * (a completed lot must never be offered back as unfinished work); a real
 * draft is stored with the timestamp the reader uses for its age window.
 */
export async function writeStoredDraft<T>(
  storage: DraftWriteStorage,
  key: string,
  draft: T | null,
  now = Date.now(),
): Promise<void> {
  if (draft == null) {
    await storage.removeItem(key);
    return;
  }
  const payload: StoredDraft<T> = { savedAt: now, draft };
  await storage.setItem(key, JSON.stringify(payload));
}

export interface StoredDraft<T> {
  savedAt: number;
  draft: T;
}

export type DraftLoadResult<T> =
  | { status: 'empty' }
  | { status: 'draft'; draft: T }
  | { status: 'unavailable' };

export interface LoadStoredDraftOptions<T> {
  /** Older than this and an ordinary draft is discarded. */
  maxAgeMs: number;
  /** Caller-supplied clock; defaults to `Date.now()`. */
  now?: number;
  /**
   * Keep a draft past `maxAgeMs`. Created-lot recovery drafts pass this so a
   * saved lot and its never-queued photos stay retryable.
   */
  retainStale?: (draft: T) => boolean;
}

async function drop(storage: DraftStorage, key: string): Promise<void> {
  try {
    await storage.removeItem(key);
  } catch {
    /* best effort: a failed delete must never block the screen */
  }
}

export async function loadStoredDraft<T>(
  storage: DraftStorage,
  key: string,
  options: LoadStoredDraftOptions<T>,
): Promise<DraftLoadResult<T>> {
  let raw: string | null;
  try {
    raw = await storage.getItem(key);
  } catch {
    // Transient read failure. Keep the record: deleting here would turn a
    // recoverable lot into a permanent loss.
    return { status: 'unavailable' };
  }
  if (!raw) return { status: 'empty' };

  let parsed: StoredDraft<T>;
  try {
    parsed = JSON.parse(raw) as StoredDraft<T>;
  } catch {
    // Corrupt JSON from a kill mid-write. Drop it; it can never be read back.
    await drop(storage, key);
    return { status: 'empty' };
  }
  if (!parsed || typeof parsed !== 'object' || !('draft' in parsed) || parsed.draft == null) {
    await drop(storage, key);
    return { status: 'empty' };
  }

  const now = options.now ?? Date.now();
  const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : null;
  const stale = savedAt === null || now - savedAt > options.maxAgeMs;
  if (stale && !options.retainStale?.(parsed.draft)) {
    await drop(storage, key);
    return { status: 'empty' };
  }

  return { status: 'draft', draft: parsed.draft };
}
