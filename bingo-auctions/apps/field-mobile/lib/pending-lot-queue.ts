// Finish the lot when the process didn't get to.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// Saving a lot is two writes, and only the second one is a row. The photos go
// to lot-photos/{operator}/_pending/ first; create_draft_lot runs after. If
// the process ends in between — reclaimed while backgrounded, a save refused
// and abandoned, the app force-quit on a spinner that never moved — the photos
// are in the bucket and the item does not exist. There is nothing half-written
// to notice: `lots` is clean, the ops page is green, and the only trace is a
// JPEG nobody reads.
//
// Prod, 2026-09-22: 105 such photos in one afternoon from one station (65 save
// attempts, three distinct images, zero lots), on top of 262 over the three
// preceding weeks. Every one of them was work someone did twice, or didn't
// get back.
//
// ── WHY A RETRY IS SAFE HERE, WHICH IS NOT OBVIOUS ───────────────────────────
// Replaying a create is normally how you mint duplicate lots — and duplicates
// are a real, expensive failure on this floor (mig 0272 exists because of 56
// duplicate pairs in 45 days). Two things make the replay safe:
//
//   * `client_dedup_token` (0272). The token keys the ACTION, not the item, so
//     a replay of the SAME intended lot returns the first lot instead of a
//     twin, even under concurrency (unique partial index). We persist the
//     token with the entry precisely so the retry carries it.
//   * `import_row_id` (0269). A manifest create is idempotent on the row, so a
//     replayed Wayfair box cannot re-match a still-'pending' row and mint an
//     orphan twin.
//
// Without those two this queue would be a duplicate factory. With them, the
// worst case of a replay is that it returns the lot the first attempt already
// made — which is the outcome we want anyway.
//
// ── WHAT IS DELIBERATELY NOT RETRIED ─────────────────────────────────────────
// An entry is dropped, not retried, when the server gave a definite answer
// (duplicate_external_code, a validation refusal): the same call would be
// refused again, and retrying it just moves the confusion to tomorrow. Only an
// UNKNOWN outcome — nothing came back — survives to be drained.
//
// Entries also expire (see MAX_AGE_MS). Creating a lot the next morning for an
// item that was put back on the truck is worse than losing the draft, and the
// same reasoning caps useDraftPersistence.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createDraftLotFromCandidate,
  type LotCandidate,
} from '@auction-platform/domain-lotting';
import { supabase } from '@auction-platform/supabase-client';

const KEY = 'lotting:pending-creates:v1';

/** Older than this and the item is no longer on the bench. Matches the spirit
 *  of useDraftPersistence's 30-minute draft window, widened because this is a
 *  finished decision (they pressed Save) rather than typing in progress. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** A pile-up means something is wrong that a queue won't fix; keep the newest
 *  and don't let a wedged device carry an unbounded backlog into a drain. */
const MAX_ENTRIES = 25;

export interface PendingLotCreate {
  /** Local id for resolve(); not the lot id. */
  id: string;
  /** 0272 idempotency token — the reason the replay is safe. Shared with the
   *  original attempt so the RPC converges instead of duplicating. */
  clientToken: string;
  candidate: LotCandidate;
  operatorId: string;
  source: string | null;
  vendor: string | null;
  importRowId: string | null;
  /** For the recovery message: what the picker would recognise. */
  title: string;
  savedAt: number;
}

async function readAll(): Promise<PendingLotCreate[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingLotCreate[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt from a kill mid-write. Drop it rather than block a save.
    try {
      await AsyncStorage.removeItem(KEY);
    } catch {
      /* nothing further to try */
    }
    return [];
  }
}

async function writeAll(entries: PendingLotCreate[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Disk pressure or a wedged store. The save itself must still proceed;
    // this is a safety net, not a gate.
  }
}

/**
 * Record the intent to create a lot, BEFORE the RPC that would create it.
 *
 * Every failure path is swallowed: this runs on the lotting hot path, and a
 * queue that can block or break a save is worse than the loss it prevents.
 */
export async function enqueuePendingLot(
  entry: Omit<PendingLotCreate, 'id' | 'savedAt'>,
): Promise<string | null> {
  try {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entries = await readAll();
    entries.push({ ...entry, id, savedAt: Date.now() });
    await writeAll(entries);
    return id;
  } catch {
    return null;
  }
}

/** The outcome is known (created, or refused) — stop tracking it. */
export async function resolvePendingLot(id: string | null): Promise<void> {
  if (!id) return;
  try {
    const entries = await readAll();
    const next = entries.filter((e) => e.id !== id);
    if (next.length !== entries.length) await writeAll(next);
  } catch {
    /* best-effort */
  }
}

export interface DrainResult {
  /** Lot codes created by the replay — what to tell the operator. */
  recovered: string[];
  /** Entries dropped for age: the item is long gone from the bench. */
  expired: number;
}

/**
 * Replay every create that never came back, oldest first.
 *
 * Safe to call on any mount; with an empty queue it costs one AsyncStorage
 * read. Entries are removed as they are decided, so a drain interrupted
 * halfway leaves the rest for the next one.
 */
export async function drainPendingLots(): Promise<DrainResult> {
  const recovered: string[] = [];
  let expired = 0;

  let entries: PendingLotCreate[];
  try {
    entries = await readAll();
  } catch {
    return { recovered, expired };
  }
  if (entries.length === 0) return { recovered, expired };

  const now = Date.now();
  const fresh: PendingLotCreate[] = [];
  for (const e of entries) {
    if (!e?.savedAt || now - e.savedAt > MAX_AGE_MS) expired += 1;
    else fresh.push(e);
  }
  // Persist the expiry immediately: if the replays below die partway, a stale
  // entry must not come back tomorrow and mint a lot for a vanished item.
  if (expired > 0) await writeAll(fresh);

  fresh.sort((a, b) => a.savedAt - b.savedAt);

  for (const e of fresh) {
    try {
      const out = await createDraftLotFromCandidate(supabase, {
        candidate: e.candidate,
        operatorId: e.operatorId,
        source: e.source,
        vendor: e.vendor,
        clientToken: e.clientToken,
        importRowId: e.importRowId,
      });
      if (out.ok) {
        recovered.push(out.lotCode);
        await resolvePendingLot(e.id);
      } else {
        // A definite refusal. The same call would be refused again — drop it
        // rather than re-ask every launch.
        await resolvePendingLot(e.id);
      }
    } catch {
      // Still unknown (offline, request lost). Leave it queued for the next
      // drain; the dedup token keeps that safe however many times it runs.
    }
  }

  return { recovered, expired };
}
