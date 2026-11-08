// Survive an OS kill mid-lot.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// Staff reports, 2026-08-15: "when I go to find a stock photo
// in Amazon, it always backs me out on BinGo and I have to start over" — still
// happening after force-closing the app.
//
// Leaving to a browser backgrounds a process that is holding a live camera and
// several decoded bitmaps. Android reclaims exactly that kind of process first,
// and it does so silently — no crash dialog, the app is simply gone and comes
// back cold. On return the in-progress lot is lost and the picker starts over.
//
// This does NOT try to stop Android killing the app. That is not winnable on a
// memory-constrained warehouse phone, and every attempt to prevent it is a
// guess about the OS. It makes the kill SURVIVABLE instead: the draft is
// written as it changes and offered back on return.
//
// ── WHY IT IS NOT ENOUGH ON ITS OWN, AND WHY IT SHIPS ANYWAY ─────────────────
// The July-21 fix (#208) capped scraped photos at 6 on the theory this was an
// OOM. That cap shipped BEFORE the Aug-11 version bump, so it reached these
// phones — and the problem persists, which means the OOM story is at best
// incomplete. A staff member's "even after force closing" points the same way: a
// fresh process with empty memory should not die from memory pressure.
//
// So the real cause is still open, and Play vitals will name it. This is worth
// shipping regardless: whatever kills the process, losing a half-finished lot
// should not be the consequence. It treats the thing staff actually complain
// about — "I have to start over" — independently of the diagnosis.
//
// ── DESIGN ───────────────────────────────────────────────────────────────────
// Writes are debounced and fire-and-forget: this runs on the lotting hot path
// and must never add latency or, worse, throw into it.
//
// A draft is offered back only if it is RECENT (default 30 min). A stale draft
// from yesterday is noise, and restoring one silently would be worse than
// losing it — the picker could save an item they are no longer holding.
//
// Every failure path is a no-op. Storage is a convenience here; a lotting
// screen that cannot start because AsyncStorage misbehaved is a far worse
// outcome than a lost draft.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { reportNonFatal } from '@/lib/session-watchdog';
import { shouldFlushDraft } from '@/lib/draft-flush';
import { createDraftMemory } from '@/lib/draft-memory';
import { createDraftPersistence } from '@/lib/draft-persistence';
import type { DraftLoadResult, StoredDraft } from '@/lib/draft-storage';
import { deletePersistedPhoto } from '@/lib/persist-photo';

const KEY_PREFIX = 'lotting:draft:';
/** Older than this and we discard rather than offer — see header. */
const MAX_AGE_MS = 30 * 60 * 1000;
/** Coalesce rapid edits; the draft only has to survive a kill, not every keystroke. */
const DEBOUNCE_MS = 800;

export type { StoredDraft };

export interface DraftPersistenceOptions<T> {
  /**
   * Keep a draft past the generic age window. Created-lot recovery drafts use
   * this: the draft is the only pointer to photos that never reached the
   * durable queue, so expiring it loses work that could still be retried
   * (RED TEAM #683 HIGH).
   */
  retainStale?: (draft: T) => boolean;
}

/**
 * @param screen  distinguishes quick / photo / manual drafts so they cannot
 *                overwrite each other.
 */
export function useDraftPersistence<T>(screen: string, options: DraftPersistenceOptions<T> = {}) {
  const retainStale = options.retainStale;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(createDraftMemory<T>()).current;
  const key = `${KEY_PREFIX}${screen}`;

  // The exact persistence core the committed tests drive (RED TEAM #762).
  const persistence = useMemo(
    () =>
      createDraftPersistence<T>(AsyncStorage, key, {
        maxAgeMs: MAX_AGE_MS,
        retainStored: retainStale,
        deleteFile: (uri) => deletePersistedPhoto(uri),
      }),
    [key, retainStale],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /** Debounced, fire-and-forget. Safe to call on every state change. */
  const write = useCallback(
    (draft: T | null) => {
      void persistence.write(draft).catch(() => {});
    },
    [persistence],
  );

  const flush = useCallback(() => {
    if (!latest.current().set) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    write(latest.current().value);
  }, [write]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (shouldFlushDraft(state)) flush();
    });
    return () => sub.remove();
  }, [flush]);

  const save = useCallback(
    (draft: T | null) => {
      latest.save(draft);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        // A cleared draft removes the key rather than storing null, so a
        // completed lot can never be offered back as unfinished work.
        write(draft);
      }, DEBOUNCE_MS);
    },
    [write],
  );

  /**
   * Read a recent draft. Self-cleaning: stale/corrupt entries are removed,
   * but a transient storage read failure leaves the record for the next read
   * (RED TEAM #683 HIGH).
   */
  const loadDraft = useCallback(async (): Promise<DraftLoadResult<T>> => {
    const result = await persistence.loadDraft();
    if (result.status === 'draft') {
      reportNonFatal({ message: `[draft-restored] ${screen}`, screen, is_fatal: false });
    }
    return result;
  }, [persistence, screen]);

  /** Read a recent draft, or null. */
  const load = useCallback((): Promise<T | null> => persistence.load(), [persistence]);

  /** Explicit discard — used on save/cancel, and when the picker declines it. */
  const clear = useCallback(() => {
    const previous = latest.current().value;
    latest.clear();
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    void persistence.clear(previous).catch(() => {});
  }, [persistence]);

  // Stable identity: callers put the store in effect dependencies. A fresh
  // object every render re-ran their mount effect, whose cleanup cancelled
  // the in-flight resume and left the saved lot half-finished.
  return useMemo(
    () => ({ save, load, loadDraft, clear, flush }),
    [save, load, loadDraft, clear, flush],
  );
}
