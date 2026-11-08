// A small persisted queue for telemetry reports: delete only after the server
// confirms, retry otherwise. Pure logic — storage and sender are injected, so
// it runs under vitest with no native modules.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// 2026-09-23: session-watchdog.ts read each piece of evidence (a saved crash, a
// never-cleared session mark, a refused OTA), DELETED it, then sent one fetch
// with a 3s cap. A slow connection — normal for customers — lost the report for
// good, and the session mark was overwritten by the new session anyway. That is
// the same send-while-dying loss #366 set out to fix, one launch later.
//
// Now the evidence is turned into reports and written here first; only then is
// the evidence cleared. Each flush sends every queued report and removes only
// the ones the server accepted. Anything else waits for the next flush.

import type { CrashReportBody } from './telemetry-post';

export const OUTBOX_KEY = 'telemetry:outbox:v1';
/** Newest reports win: a phone offline for weeks should not grow storage forever. */
export const OUTBOX_MAX = 20;
/** A report older than this is no longer worth sending. */
export const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface OutboxEntry {
  body: CrashReportBody;
  queuedAt: number;
  attempts: number;
}

/** Resolves true only when the server accepted the report. */
export type SendReport = (body: CrashReportBody) => Promise<boolean>;

// Every read-modify-write goes through one chain, so an enqueue that lands
// while a flush is waiting on the network is not overwritten by that flush.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Parse the stored queue defensively: a kill mid-write can leave anything. */
export function parseOutbox(raw: string | null): OutboxEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is OutboxEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as OutboxEntry).body?.message === 'string' &&
        typeof (e as OutboxEntry).queuedAt === 'number',
    );
  } catch {
    return [];
  }
}

function trim(entries: OutboxEntry[], now: number): OutboxEntry[] {
  return entries.filter((e) => now - e.queuedAt <= OUTBOX_MAX_AGE_MS).slice(-OUTBOX_MAX);
}

/**
 * Persist reports before their evidence is cleared. Resolves true once the
 * queue is written; callers must not delete the evidence otherwise.
 */
export function enqueueReports(
  store: KeyValueStore,
  bodies: CrashReportBody[],
  now: number,
): Promise<boolean> {
  if (bodies.length === 0) return Promise.resolve(true);
  return serial(async () => {
    try {
      const queued = parseOutbox(await store.getItem(OUTBOX_KEY));
      const added = bodies.map((body) => ({ body, queuedAt: now, attempts: 0 }));
      await store.setItem(OUTBOX_KEY, JSON.stringify(trim([...queued, ...added], now)));
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Send everything queued. Accepted reports leave the queue; the rest stay for
 * the next flush with their attempt count raised. Never throws.
 */
export function flushOutbox(
  store: KeyValueStore,
  send: SendReport,
  now: number,
): Promise<{ sent: number; kept: number }> {
  return serial(async () => {
    let queued: OutboxEntry[];
    try {
      queued = trim(parseOutbox(await store.getItem(OUTBOX_KEY)), now);
    } catch {
      return { sent: 0, kept: 0 };
    }
    if (queued.length === 0) return { sent: 0, kept: 0 };
    const kept: OutboxEntry[] = [];
    let sent = 0;
    for (const entry of queued) {
      let ok = false;
      try {
        ok = await send(entry.body);
      } catch {
        ok = false;
      }
      if (ok) sent += 1;
      else kept.push({ ...entry, attempts: entry.attempts + 1 });
    }
    try {
      await store.setItem(OUTBOX_KEY, JSON.stringify(kept));
    } catch {
      // Worst case the sent ones go again next time: a duplicate beats a loss.
    }
    return { sent, kept: kept.length };
  });
}
