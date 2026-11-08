// Latency harness (2026-10-08): how long does a Pre-stickered save hold the
// lotting screen on bad wifi, with #416 as shipped versus this fix?
//
// What is real here and what is modelled:
//   - REAL: bindStickerToLot (its timeout + abort), bindNowOrQueue and
//     drainPendingBinds, run against a fake Supabase whose every request takes
//     a chosen time, errors, or never answers.
//   - MODELLED: the order of awaits in each screen's save function, copied
//     from the code (file:line in each flow below). The screens themselves
//     are React Native components and are not rendered; nothing here ran on a
//     phone or with real wifi.
//
// Two numbers per flow:
//   scannerWait — tap Save → the sticker capture scanner is on screen (Quick
//                 Lot, when the creating scan is not itself the sticker).
//   held        — the sticker is in hand → the screen lets go (spinner off,
//                 camera back, next scan/save accepted).
// Not counted (identical before and after, not network): the 0.9 s "Sticker
// scanned" confirmation, and the photo uploads Photo and Manual already
// awaited on Sep 28.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Net = { latencyMs: number | 'hang'; error?: boolean };
const net: { create: Net; lookup: Net; bind: Net } = {
  create: { latencyMs: 300 },
  lookup: { latencyMs: 300 },
  bind: { latencyMs: 300 },
};
const calls = { bind: 0 };

/** One request on the fake network. Resolves the postgrest shape. */
function request<T>(n: Net, data: T, signal?: AbortSignal): Promise<{ data: T | null; error: { message: string } | null }> {
  return new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    if (n.latencyMs === 'hang') return;
    setTimeout(
      () => resolve(n.error ? { data: null, error: { message: 'TypeError: Network request failed' } } : { data, error: null }),
      n.latencyMs,
    );
  });
}

vi.mock('@auction-platform/supabase-client', () => ({
  supabase: {
    rpc: (_name: string, args: { p_lot_id: string }) => {
      calls.bind += 1;
      let signal: AbortSignal | undefined;
      const builder = {
        abortSignal(s: AbortSignal) {
          signal = s;
          return request(net.bind, { ok: true, lot_id: args.p_lot_id, idempotent: false }, signal);
        },
        then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
          // #416's bindStickerToLot awaited the builder directly (no signal).
          return request(net.bind, { ok: true, lot_id: args.p_lot_id, idempotent: false }, signal).then(onOk, onErr);
        },
      };
      return builder;
    },
  },
}));

// Imported after the mock is declared (vi.mock is hoisted anyway).
import { bindStickerToLot } from '../features/lotting/bindStickerToLot';
import {
  BIND_TIMEOUT_MS,
  SAVE_LOOKUP_TIMEOUT_MS,
  bindNowOrQueue,
  drainPendingBinds,
  withTimeout,
  type KeyValueStore,
} from './sticker-bind-queue';
import { supabase } from '@auction-platform/supabase-client';

const store: KeyValueStore & { data: Record<string, string> } = {
  data: {},
  getItem: async (k) => store.data[k] ?? null,
  setItem: async (k, v) => {
    store.data[k] = v;
  },
};

const lookup = () => request(net.lookup, { operator_id: 'op-1' }).then((r) => (r.error ? null : 'op-1'));
/** createDraftLotFromCandidate: category alias select, then create_draft_lot. */
const create = async () => {
  await request(net.create, null);
  const r = await request(net.create, { lot_id: 'lot-1', lot_code: 'TST-000001' });
  return !r.error;
};
/** bindStickerToLot as #416 shipped it: one RPC, awaited, no limit. */
const bind416 = async () => {
  const { error } = (await (supabase.rpc('claim_sticker_code', { p_lot_id: 'lot-1' }) as unknown as Promise<{
    error: unknown;
  }>)) as { error: unknown };
  return !error;
};

interface Times {
  scannerWait?: number;
  held?: number;
  /** The lot exists when the screen lets go. */
  saved?: boolean;
}

// ── #416 as shipped ────────────────────────────────────────────────────────
// quick.tsx (3341a68) createLot: L826 await resolveOperatorIdForUpload →
// sticker plan → capture scanner; after the scan createLot runs again: L826
// lookup again → L918 create → L1052 await bindStickerToLot → finally
// setCreating(false).
async function quick416(t: Times, start: number) {
  await lookup();
  t.scannerWait = Date.now() - start;
  const scanned = Date.now();
  const op = await lookup();
  t.saved = Boolean(op) && (await create());
  if (t.saved) await bind416();
  t.held = Date.now() - scanned;
}
// photo.tsx L1046 / manual.tsx L523 / web.tsx L540: create, then
// await bindStickerToLot before `creating` / `busy` is released.
async function screen416(t: Times) {
  const scanned = Date.now();
  t.saved = await create();
  if (t.saved) await bind416();
  t.held = Date.now() - scanned;
}

// ── This fix ───────────────────────────────────────────────────────────────
// quick.tsx: sticker plan first (no network) → capture scanner; after the
// scan: lookup bounded by SAVE_LOOKUP_TIMEOUT_MS → create → bind NOT awaited.
async function quickFixed(t: Times, start: number) {
  t.scannerWait = Date.now() - start;
  const scanned = Date.now();
  const op = await withTimeout<string | null | 'timeout'>(lookup(), SAVE_LOOKUP_TIMEOUT_MS, () => 'timeout');
  t.saved = Boolean(op) && op !== 'timeout' && (await create());
  if (t.saved) {
    void bindNowOrQueue(store, (l, s) => bindStickerToLot(l, s), { lotId: 'lot-1', lotCode: 'TST-000001', sticker: 'TEA0000001' }, Date.now);
  }
  t.held = Date.now() - scanned;
}
// photo / manual / web: create → bind NOT awaited.
async function screenFixed(t: Times) {
  const scanned = Date.now();
  t.saved = await create();
  if (t.saved) {
    void bindNowOrQueue(store, (l, s) => bindStickerToLot(l, s), { lotId: 'lot-1', lotCode: 'TST-000001', sticker: 'TEA0000001' }, Date.now);
  }
  t.held = Date.now() - scanned;
}

const CAP_MS = 120_000;
async function measure(flow: (t: Times, start: number) => Promise<void>): Promise<Times> {
  const t: Times = {};
  const start = Date.now();
  let done = false;
  void flow(t, start).then(() => (done = true));
  for (let waited = 0; !done && waited < CAP_MS; waited += 100) {
    await vi.advanceTimersByTimeAsync(100);
  }
  return t;
}
const fmt = (ms: number | undefined) => (ms === undefined ? `>${CAP_MS / 1000} s (never)` : `${(ms / 1000).toFixed(1)} s`);
const held = (t: Times) => `${fmt(t.held)}${t.held === undefined ? '' : t.saved ? ' saved' : ' not saved'}`;

const SCENARIOS: Array<{ name: string; create: Net; lookup: Net; bind: Net }> = [
  { name: 'good wifi, 0.3 s per request', create: { latencyMs: 300 }, lookup: { latencyMs: 300 }, bind: { latencyMs: 300 } },
  { name: 'slow wifi, 3 s per request', create: { latencyMs: 3000 }, lookup: { latencyMs: 3000 }, bind: { latencyMs: 3000 } },
  { name: 'very slow, 10 s per request', create: { latencyMs: 10_000 }, lookup: { latencyMs: 10_000 }, bind: { latencyMs: 10_000 } },
  { name: 'only the bind hangs', create: { latencyMs: 300 }, lookup: { latencyMs: 300 }, bind: { latencyMs: 'hang' } },
  { name: 'offline, errors after 0.2 s', create: { latencyMs: 200, error: true }, lookup: { latencyMs: 200, error: true }, bind: { latencyMs: 200, error: true } },
  { name: 'offline, no answer ever', create: { latencyMs: 'hang' }, lookup: { latencyMs: 'hang' }, bind: { latencyMs: 'hang' } },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_790_000_000_000);
  store.data = {};
  calls.bind = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Pre-stickered save on bad wifi: #416 vs this fix', () => {
  const rows: string[] = [];

  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      Object.assign(net, { create: sc.create, lookup: sc.lookup, bind: sc.bind });
      const q416 = await measure(quick416);
      const qFix = await measure(quickFixed);
      const s416 = await measure((t) => screen416(t));
      const sFix = await measure((t) => screenFixed(t));
      rows.push(
        `| ${sc.name} | ${fmt(q416.scannerWait)} → ${fmt(qFix.scannerWait)} | ${held(q416)} → ${held(qFix)} | ${held(s416)} → ${held(sFix)} |`,
      );

      // The capture scanner never waits on the network now.
      expect(qFix.scannerWait).toBe(0);
      // Never worse than #416; the bind is never on the held time.
      // fix is worse than old: it never lets go while old did, or takes longer.
      const worse = (fix: number | undefined, old: number | undefined) =>
        fix === undefined ? old !== undefined : old !== undefined && fix > old;
      expect(worse(qFix.held, q416.held)).toBe(false);
      expect(worse(sFix.held, s416.held)).toBe(false);
      if (sc.create.latencyMs !== 'hang' && sc.lookup.latencyMs !== 'hang') {
        const perReq = sc.create.latencyMs as number;
        expect(sFix.held).toBe(2 * perReq); // create only: alias select + RPC
      }
      // Quick Lot's lookup is bounded: no answer at all still lets go.
      expect(qFix.held).toBeDefined();
      expect(qFix.held!).toBeLessThanOrEqual(SAVE_LOOKUP_TIMEOUT_MS + 2 * 10_000);
      // A network that answers (even at 10 s a request) still saves.
      if (sc.create.latencyMs !== 'hang' && !sc.create.error) expect(qFix.saved && sFix.saved).toBe(true);
    });
  }

  it('prints the table', () => {
    console.log(
      ['', '| scenario | Quick: tap → scanner open | Quick: sticker → screen free | Photo/Manual/Web: sticker → screen free |', '|---|---|---|---|', ...rows].join('\n'),
    );
    expect(rows).toHaveLength(SCENARIOS.length);
  });
});

describe('the deferred bind still lands, without a tight loop', () => {
  it('bind hangs for 10 minutes, then wifi recovers: bound, with few attempts', async () => {
    Object.assign(net, { create: { latencyMs: 300 }, lookup: { latencyMs: 300 }, bind: { latencyMs: 'hang' } });
    const t = await measure((x) => screenFixed(x));
    expect(t.held).toBe(600);
    await vi.advanceTimersByTimeAsync(BIND_TIMEOUT_MS); // the first attempt times out → queued

    // The runner's loop: drain, then sleep until the next entry is due.
    const until = Date.now() + 10 * 60_000;
    let res = await drainPendingBinds(store, (l, s) => bindStickerToLot(l, s), Date.now);
    while (Date.now() < until) {
      const wait = Math.max(1_000, (res.nextDueAt ?? Date.now() + 60_000) - Date.now());
      await vi.advanceTimersByTimeAsync(wait);
      const p = drainPendingBinds(store, (l, s) => bindStickerToLot(l, s), Date.now);
      await vi.advanceTimersByTimeAsync(BIND_TIMEOUT_MS);
      res = await p;
    }
    const attemptsWhileDown = calls.bind;
    expect(attemptsWhileDown).toBeLessThanOrEqual(8); // 1 + backoff 15/30/60/120/240/300 s…

    net.bind = { latencyMs: 300 };
    await vi.advanceTimersByTimeAsync(Math.max(0, (res.nextDueAt ?? 0) - Date.now()));
    const p = drainPendingBinds(store, (l, s) => bindStickerToLot(l, s), Date.now);
    await vi.advanceTimersByTimeAsync(300);
    const final = await p;
    expect(final.bound.map((e) => e.sticker)).toEqual(['TEA0000001']);
    expect(final.kept).toBe(0);
    console.log(`bind attempts during 10 min of no answer: ${attemptsWhileDown}; bound on the first try after recovery`);
  });
});
