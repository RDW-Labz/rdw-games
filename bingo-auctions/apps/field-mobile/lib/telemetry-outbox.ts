// A small persisted queue for telemetry reports: delete only after the server
// confirms, retry otherwise. Pure logic — storage and sender are injected, so
// it runs under vitest with no native modules. Same design as
// apps/bidder-app/lib/telemetry-outbox.ts.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// 2026-09-23: session-watchdog.ts read each piece of evidence (a saved crash, a
// never-cleared session mark), DELETED it, then sent one fetch with a 3s cap.
// Warehouse wifi drops out; a failed send lost the report for good, and the
// session mark was overwritten by the new session anyway. That is the same
// send-while-dying loss the saved-crash change set out to fix, one launch later.
//
// Now the evidence is turned into reports and written here first; only then is
// the evidence cleared. Each flush sends every queued report and removes only
// the ones the server accepted. Anything else waits for the next flush.
//
// 2026-09-28 (review of this PR): two more ways a report went wrong.
//   - Sent twice: the server stored it but the reply was lost, so the next
//     flush stored it again (2 of ~8 in the staff-canary rehearsal). Each entry
//     now carries a report id, the same on every resend; the server ignores a
//     second insert with that id (mig 0375).
//   - Sent for a week: a report the server rejects (4xx) failed the same way on
//     every flush until OUTBOX_MAX_AGE_MS. The sender now says whether to
//     retry; a rejection is dropped, and OUTBOX_MAX_ATTEMPTS is the backstop.

/** What session-watchdog.ts posts to /api/telemetry/crash (app/platform added there). */
export interface CrashReportBody {
  message: string;
  stack?: string;
  screen: string;
  app_version?: string;
  ota_update?: string;
  is_fatal: boolean;
}

export const OUTBOX_KEY = 'telemetry:outbox:v1';
/** Newest reports win: a phone offline for weeks should not grow storage forever. */
export const OUTBOX_MAX = 20;
/** A report older than this is no longer worth sending. */
export const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Backstop for a report that keeps failing for a reason the server never names. */
export const OUTBOX_MAX_ATTEMPTS = 50;

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface OutboxEntry {
  /** Sent as report_id on every attempt, so the server stores it once. */
  id: string;
  body: CrashReportBody;
  queuedAt: number;
  attempts: number;
}

/**
 * accepted: the server has it (any 2xx), remove it.
 * rejected: the server will never take this body (4xx), remove it.
 * retry: network, timeout or 5xx, keep it for the next flush.
 */
export type SendOutcome = 'accepted' | 'rejected' | 'retry';
export type SendReport = (body: CrashReportBody, reportId: string) => Promise<SendOutcome>;

/** HTTP status → outcome. 408 / 429 are "try later", not a verdict on the body. */
export function sendOutcomeFor(status: number): SendOutcome {
  if (status >= 200 && status < 300) return 'accepted';
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'rejected';
  return 'retry';
}

/** RFC 4122 v4. Only needs to be unique per report, not unguessable. */
export function newReportId(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Every read-modify-write goes through one chain, so an enqueue that lands
// while a flush is waiting on the network is not overwritten by that flush.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/**
 * Parse the stored queue defensively: a kill mid-write can leave anything.
 * An entry without an id (queued before ids existed) gets one here; the next
 * write persists it, so its later resends share it.
 */
export function parseOutbox(raw: string | null, newId: () => string = newReportId): OutboxEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (e): e is OutboxEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as OutboxEntry).body?.message === 'string' &&
          typeof (e as OutboxEntry).queuedAt === 'number',
      )
      .map((e) => ({
        ...e,
        id: typeof e.id === 'string' && e.id ? e.id : newId(),
        attempts: typeof e.attempts === 'number' ? e.attempts : 0,
      }));
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
  newId: () => string = newReportId,
): Promise<boolean> {
  if (bodies.length === 0) return Promise.resolve(true);
  return serial(async () => {
    try {
      const queued = parseOutbox(await store.getItem(OUTBOX_KEY), newId);
      const added = bodies.map((body) => ({ id: newId(), body, queuedAt: now, attempts: 0 }));
      await store.setItem(OUTBOX_KEY, JSON.stringify(trim([...queued, ...added], now)));
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Send everything queued. Accepted and rejected reports leave the queue; the
 * rest stay for the next flush with their attempt count raised, until
 * OUTBOX_MAX_ATTEMPTS. Never throws.
 */
export function flushOutbox(
  store: KeyValueStore,
  send: SendReport,
  now: number,
): Promise<{ sent: number; kept: number; dropped: number }> {
  return serial(async () => {
    let queued: OutboxEntry[];
    try {
      queued = trim(parseOutbox(await store.getItem(OUTBOX_KEY)), now);
    } catch {
      return { sent: 0, kept: 0, dropped: 0 };
    }
    if (queued.length === 0) return { sent: 0, kept: 0, dropped: 0 };
    const kept: OutboxEntry[] = [];
    let sent = 0;
    let dropped = 0;
    for (const entry of queued) {
      let outcome: SendOutcome = 'retry';
      try {
        outcome = await send(entry.body, entry.id);
      } catch {
        outcome = 'retry';
      }
      if (outcome === 'accepted') sent += 1;
      else if (outcome === 'rejected' || entry.attempts + 1 >= OUTBOX_MAX_ATTEMPTS) dropped += 1;
      else kept.push({ ...entry, attempts: entry.attempts + 1 });
    }
    try {
      await store.setItem(OUTBOX_KEY, JSON.stringify(kept));
    } catch {
      // Worst case the sent ones go again next time: a duplicate beats a loss.
    }
    return { sent, kept: kept.length, dropped };
  });
}
