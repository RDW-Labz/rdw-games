// My Bids live-update rules (2026-09-26). Pure — no React, no supabase — so
// the "which events reload the list" and "which load wins" rules are testable.
//
// Owner requirement: My Bids reloads only for changes on lots this bidder has
// bid on, never for every bid on the platform, and an older reload must never
// overwrite a newer one.
//
// Realtime Postgres Changes authorizes each event against the subscriber's RLS
// ("Postgres Changes authorizes every event against each subscriber" —
// supabase.com/docs/guides/realtime/postgres-changes). bids_self_read means a
// bidder only ever receives HER OWN bid rows, so a `bids` listener alone never
// hears about being outbid (the outbidder's row isn't hers). The screen
// therefore also listens to `lots` UPDATEs on her open lots — current price
// and winner_bidder_id live there.

/** Realtime's `in` filter accepts at most 100 values. */
export const REALTIME_IN_FILTER_MAX = 100;

export function chunkIds(ids: readonly string[], size = REALTIME_IN_FILTER_MAX): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Stable key for a set of lot ids — re-subscribe only when this changes. */
export function lotSetKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(',');
}

export type MyBidsChange =
  | { table: 'bids'; record: { lot_id?: unknown; bidder_id?: unknown } }
  | { table: 'lots'; record: { id?: unknown } };

// Belt and braces on top of the server-side filters:
//   bids — her own new bid always reloads (it may be on a lot not yet in the
//          list); any other bid only if it's on one of her lots.
//   lots — only lots already in her list.
export function shouldReloadForEvent(
  change: MyBidsChange,
  uid: string,
  lotIds: ReadonlySet<string>,
): boolean {
  if (change.table === 'bids') {
    const { bidder_id, lot_id } = change.record;
    return bidder_id === uid || (typeof lot_id === 'string' && lotIds.has(lot_id));
  }
  const { id } = change.record;
  return typeof id === 'string' && lotIds.has(id);
}

// Load sequencing: begin() stamps a load and returns isLatest(), which stays
// true only until the next begin(). Every setState in a load checks it, so a
// slow older load can't overwrite a newer one.
export function createLoadSequencer(): { begin: () => () => boolean } {
  let latest = 0;
  return {
    begin() {
      const seq = ++latest;
      return () => seq === latest;
    },
  };
}

// Realtime reload timing: trailing debounce WITH a max wait. A pure trailing
// debounce starves during a closing-time bidding stream (events < 1.5s apart
// for minutes → no reload, stale Leading/Outbid exactly when it matters).
// Fire `wait` after the last event or `maxWait` after the first pending one,
// whichever is sooner; firing resets the burst.
export const RELOAD_WAIT_MS = 1500;
export const RELOAD_MAX_WAIT_MS = 5000;

export function nextFireAt(
  firstEventAt: number,
  lastEventAt: number,
  wait = RELOAD_WAIT_MS,
  maxWait = RELOAD_MAX_WAIT_MS,
): number {
  return Math.min(lastEventAt + wait, firstEventAt + maxWait);
}

type TimerFns = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

const realTimers: TimerFns = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createReloadDebouncer(
  fire: () => void,
  timers: TimerFns = realTimers,
  wait = RELOAD_WAIT_MS,
  maxWait = RELOAD_MAX_WAIT_MS,
): { schedule: () => void; cancel: () => void } {
  let firstAt: number | null = null;
  let handle: unknown = null;
  return {
    schedule() {
      const t = timers.now();
      if (firstAt === null) firstAt = t;
      if (handle !== null) timers.clearTimer(handle);
      handle = timers.setTimer(() => {
        handle = null;
        firstAt = null;
        fire();
      }, Math.max(0, nextFireAt(firstAt, t, wait, maxWait) - t));
    },
    cancel() {
      if (handle !== null) timers.clearTimer(handle);
      handle = null;
      firstAt = null;
    },
  };
}
