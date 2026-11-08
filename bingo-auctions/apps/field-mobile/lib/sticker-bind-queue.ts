// Bind the scanned sticker AFTER the lot is saved, without making the save
// wait for it, and without losing it when the wifi is bad.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// #416 (2026-10-06) made Pre-stickered mode scan the sticker before the save
// (owner's rule: no sticker scanned, no save). The scan itself is local; but
// every lotting screen then awaited the bind RPC (claim_sticker_code /
// claim_prestickered_qr) inside the save, with no timeout. On warehouse wifi
// that kept the save spinner up, the Quick Lot camera off and the next scan
// locked for as long as the request hung: on Android, React Native's HTTP
// client has no timeout at all, so "as long as" can mean until the app is
// killed (floor, 2026-10-08).
//
// Now the save releases the screen as soon as the lot exists. The bind gets
// one time-boxed attempt. A definite answer from the server ("sticker already
// on another lot") comes back to the screen as before. A slow or failed
// network keeps the sticker on the phone (this queue) and retries it with
// backoff, so the scanned sticker still reaches the lot.
//
// Pure logic: storage, the bind call and the clock are injected, so this runs
// under vitest. features/lotting/stickerBindRunner.ts wires it to the app.

export const PENDING_BINDS_KEY = 'lotting:sticker-binds:v1';
/** One bind attempt never holds anything longer than this. */
export const BIND_TIMEOUT_MS = 8_000;
/** Quick Lot's operator-id lookup before the create (2026-10-08). Longer than
 *  a bind's limit: a slow-but-working network should still save. */
export const SAVE_LOOKUP_TIMEOUT_MS = 15_000;
/** The reason a timed-out attempt reports. */
export const BIND_TIMEOUT_REASON = 'bind_timeout';
/** Backstop: after this many failed tries the entry is surfaced, not retried. */
export const MAX_BIND_ATTEMPTS = 30;
/** A queued bind older than this is surfaced, not retried. */
export const MAX_BIND_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PendingBind {
  lotId: string;
  lotCode: string;
  sticker: string;
  queuedAt: number;
  attempts: number;
  /** Not tried again before this time (backoff). */
  nextAttemptAt: number;
  lastReason: string;
}

export type BindResult = { ok: true } | { ok: false; reason: string };
export type BindFn = (lotId: string, sticker: string) => Promise<BindResult>;

export type BindOutcome =
  /** The sticker is on the lot. */
  | { kind: 'bound' }
  /** The server (or the client guard) said no. A person has to act. */
  | { kind: 'refused'; reason: string }
  /** No answer in time, or no network. Kept on the phone and retried. */
  | { kind: 'queued'; reason: string };

/**
 * Resolve with `onTimeout()` if `p` has not settled within `ms`. A rejection of
 * `p` passes through. The underlying request is not cancelled here; callers
 * that can abort (an AbortSignal) should do so as well.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const RETRYABLE_RE =
  /bind_timeout|timed? ?out|timeout|network request failed|network error|fetch failed|failed to fetch|load failed|abort|ECONNRESET|ECONNREFUSED|socket|gateway|\b50[0-4]\b|JWT expired|unknown_error/i;

/** Network trouble (try again later) as opposed to an answer (tell a person). */
export function isRetryableBindFailure(reason: string): boolean {
  return RETRYABLE_RE.test(reason);
}

/** 15 s, 30 s, 60 s … capped at 5 min. Never a tight loop. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

export function parsePendingBinds(raw: string | null): PendingBind[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is PendingBind =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as PendingBind).lotId === 'string' &&
        typeof (e as PendingBind).sticker === 'string' &&
        typeof (e as PendingBind).queuedAt === 'number',
    );
  } catch {
    return [];
  }
}

// Every read-modify-write of the stored list goes through one chain. The
// network never runs inside it, so a slow bind cannot hold up an enqueue.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function attempt(bind: BindFn, lotId: string, sticker: string, timeoutMs: number): Promise<BindResult> {
  try {
    return await withTimeout<BindResult>(bind(lotId, sticker), timeoutMs, () => ({
      ok: false,
      reason: BIND_TIMEOUT_REASON,
    }));
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message || 'unknown_error' };
  }
}

/** Put a bind on the phone for later. Same lot + sticker replaces, not duplicates. */
export function enqueuePendingBind(
  store: KeyValueStore,
  entry: { lotId: string; lotCode: string; sticker: string; reason: string },
  now: number,
): Promise<boolean> {
  return serial(async () => {
    try {
      const list = parsePendingBinds(await store.getItem(PENDING_BINDS_KEY)).filter(
        (e) => !(e.lotId === entry.lotId && e.sticker === entry.sticker),
      );
      list.push({
        lotId: entry.lotId,
        lotCode: entry.lotCode,
        sticker: entry.sticker,
        queuedAt: now,
        attempts: 1,
        nextAttemptAt: now + backoffMs(1),
        lastReason: entry.reason,
      });
      await store.setItem(PENDING_BINDS_KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The step right after a save: one attempt, time-boxed. Never throws.
 * The caller does not await this on its save path.
 */
export async function bindNowOrQueue(
  store: KeyValueStore,
  bind: BindFn,
  input: { lotId: string; lotCode: string; sticker: string },
  now: () => number,
  timeoutMs: number = BIND_TIMEOUT_MS,
): Promise<BindOutcome> {
  const res = await attempt(bind, input.lotId, input.sticker, timeoutMs);
  if (res.ok) return { kind: 'bound' };
  if (!isRetryableBindFailure(res.reason)) return { kind: 'refused', reason: res.reason };
  await enqueuePendingBind(store, { ...input, reason: res.reason }, now());
  return { kind: 'queued', reason: res.reason };
}

export interface DrainResult {
  bound: PendingBind[];
  /** Answered no by the server, or given up on. Someone has to fix these. */
  refused: Array<{ entry: PendingBind; reason: string }>;
  /** Still waiting. */
  kept: number;
  /** When the next entry is due, or null when the queue is empty. */
  nextDueAt: number | null;
}

let draining: Promise<DrainResult> | null = null;

/**
 * Retry what is due, one at a time. Stops at the first network failure: the
 * wifi is still bad, so the rest wait for their own backoff instead of each
 * spending a timeout now. Only one drain runs at a time. Never throws.
 */
export function drainPendingBinds(
  store: KeyValueStore,
  bind: BindFn,
  now: () => number,
  timeoutMs: number = BIND_TIMEOUT_MS,
): Promise<DrainResult> {
  if (draining) return draining;
  draining = (async (): Promise<DrainResult> => {
    let list: PendingBind[];
    try {
      list = parsePendingBinds(await serial(() => store.getItem(PENDING_BINDS_KEY)));
    } catch {
      return { bound: [], refused: [], kept: 0, nextDueAt: null };
    }
    const bound: PendingBind[] = [];
    const refused: Array<{ entry: PendingBind; reason: string }> = [];
    const updated = new Map<PendingBind, PendingBind>();
    let networkDown = false;
    for (const entry of list) {
      const t = now();
      if (t - entry.queuedAt > MAX_BIND_AGE_MS || entry.attempts >= MAX_BIND_ATTEMPTS) {
        refused.push({ entry, reason: `gave_up_after_retries: ${entry.lastReason}` });
        continue;
      }
      if (networkDown || entry.nextAttemptAt > t) continue;
      const res = await attempt(bind, entry.lotId, entry.sticker, timeoutMs);
      if (res.ok) {
        bound.push(entry);
      } else if (!isRetryableBindFailure(res.reason)) {
        refused.push({ entry, reason: res.reason });
      } else {
        networkDown = true;
        const attempts = entry.attempts + 1;
        updated.set(entry, { ...entry, attempts, nextAttemptAt: now() + backoffMs(attempts), lastReason: res.reason });
      }
    }
    const done = new Set<PendingBind>([...bound, ...refused.map((r) => r.entry)]);
    const key = (e: PendingBind) => `${e.lotId}\u0000${e.sticker}\u0000${e.queuedAt}`;
    const doneKeys = new Set([...done].map(key));
    const updatedByKey = new Map([...updated].map(([from, to]) => [key(from), to]));
    // Merge onto the CURRENT list: an enqueue may have landed while we waited.
    const remaining = await serial(async () => {
      try {
        const current = parsePendingBinds(await store.getItem(PENDING_BINDS_KEY));
        const next = current
          .filter((e) => !doneKeys.has(key(e)))
          .map((e) => updatedByKey.get(key(e)) ?? e);
        await store.setItem(PENDING_BINDS_KEY, JSON.stringify(next));
        return next;
      } catch {
        return list.filter((e) => !done.has(e));
      }
    });
    const nextDueAt = remaining.length ? Math.min(...remaining.map((e) => e.nextAttemptAt)) : null;
    return { bound, refused, kept: remaining.length, nextDueAt };
  })().finally(() => {
    draining = null;
  });
  return draining;
}
