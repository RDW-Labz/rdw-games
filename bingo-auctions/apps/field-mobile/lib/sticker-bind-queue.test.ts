// Sticker bind after save: time-boxed, queued on network failure, retried with
// backoff, refusals surfaced. Fake lots and codes only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BIND_TIMEOUT_MS,
  BIND_TIMEOUT_REASON,
  MAX_BIND_ATTEMPTS,
  PENDING_BINDS_KEY,
  backoffMs,
  bindNowOrQueue,
  drainPendingBinds,
  isRetryableBindFailure,
  parsePendingBinds,
  withTimeout,
  type BindFn,
  type KeyValueStore,
} from './sticker-bind-queue';

function memoryStore(): KeyValueStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}
const queued = (s: { data: Record<string, string> }) => parsePendingBinds(s.data[PENDING_BINDS_KEY] ?? null);
const LOT = { lotId: 'lot-1', lotCode: 'TST-000001', sticker: 'TEA0000001' };
const never: BindFn = () => new Promise(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_790_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('isRetryableBindFailure', () => {
  it('network trouble is retried', () => {
    for (const r of [BIND_TIMEOUT_REASON, 'TypeError: Network request failed', 'AbortError: Aborted', 'Load failed', '502 Bad Gateway', 'JWT expired']) {
      expect(isRetryableBindFailure(r)).toBe(true);
    }
  });
  it("the server's answers are not", () => {
    for (const r of ['sticker_code_already_used', 'qr_token_already_used', 'raw_code_is_live_lot_code', 'not_operator_staff', 'lot_already_has_different_sticker']) {
      expect(isRetryableBindFailure(r)).toBe(false);
    }
  });
});

describe('backoffMs', () => {
  it('grows and caps; never under 15 s', () => {
    expect(backoffMs(1)).toBe(15_000);
    expect(backoffMs(2)).toBe(30_000);
    expect(backoffMs(3)).toBe(60_000);
    expect(backoffMs(20)).toBe(300_000);
  });
});

describe('withTimeout', () => {
  it('answers with the fallback when the promise hangs', async () => {
    const p = withTimeout(new Promise<string>(() => {}), 1000, () => 'late');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe('late');
  });
});

describe('bindNowOrQueue', () => {
  it('bound on a quick answer, nothing queued', async () => {
    const store = memoryStore();
    const out = await bindNowOrQueue(store, async () => ({ ok: true }), LOT, Date.now);
    expect(out).toEqual({ kind: 'bound' });
    expect(queued(store)).toEqual([]);
  });

  it('a refusal comes back to the screen and is not queued', async () => {
    const store = memoryStore();
    const out = await bindNowOrQueue(store, async () => ({ ok: false, reason: 'sticker_code_already_used' }), LOT, Date.now);
    expect(out).toEqual({ kind: 'refused', reason: 'sticker_code_already_used' });
    expect(queued(store)).toEqual([]);
  });

  it('a hung request gives up at BIND_TIMEOUT_MS and keeps the sticker', async () => {
    const store = memoryStore();
    const p = bindNowOrQueue(store, never, LOT, Date.now);
    await vi.advanceTimersByTimeAsync(BIND_TIMEOUT_MS);
    await expect(p).resolves.toEqual({ kind: 'queued', reason: BIND_TIMEOUT_REASON });
    expect(queued(store).map((e) => [e.lotCode, e.sticker, e.attempts])).toEqual([['TST-000001', 'TEA0000001', 1]]);
  });

  it('a thrown network error is queued', async () => {
    const store = memoryStore();
    const out = await bindNowOrQueue(store, async () => {
      throw new TypeError('Network request failed');
    }, LOT, Date.now);
    expect(out.kind).toBe('queued');
    expect(queued(store)).toHaveLength(1);
  });

  it('the same lot and sticker queued twice is one entry', async () => {
    const store = memoryStore();
    const fail: BindFn = async () => ({ ok: false, reason: 'Network request failed' });
    await bindNowOrQueue(store, fail, LOT, Date.now);
    await bindNowOrQueue(store, fail, LOT, Date.now);
    expect(queued(store)).toHaveLength(1);
  });
});

describe('drainPendingBinds', () => {
  it('waits for the backoff, then binds once the network is back', async () => {
    const store = memoryStore();
    await bindNowOrQueue(store, async () => ({ ok: false, reason: 'Network request failed' }), LOT, Date.now);
    const calls: string[] = [];
    const ok: BindFn = async (lotId) => (calls.push(lotId), { ok: true });

    const early = await drainPendingBinds(store, ok, Date.now);
    expect(calls).toEqual([]); // not due yet
    expect(early.kept).toBe(1);
    expect(early.nextDueAt).toBe(Date.now() + 15_000);

    vi.advanceTimersByTime(15_000);
    const due = await drainPendingBinds(store, ok, Date.now);
    expect(calls).toEqual(['lot-1']);
    expect(due.bound.map((e) => e.sticker)).toEqual(['TEA0000001']);
    expect(queued(store)).toEqual([]);
    expect(due.nextDueAt).toBeNull();
  });

  it('stops at the first network failure instead of timing out on every entry', async () => {
    const store = memoryStore();
    const fail: BindFn = async () => ({ ok: false, reason: 'Network request failed' });
    for (let i = 1; i <= 5; i++) {
      await bindNowOrQueue(store, fail, { lotId: `lot-${i}`, lotCode: `TST-00000${i}`, sticker: `TEA000000${i}` }, Date.now);
    }
    vi.advanceTimersByTime(15_000);
    let calls = 0;
    const p = drainPendingBinds(store, () => (calls++, new Promise(() => {})), Date.now);
    await vi.advanceTimersByTimeAsync(BIND_TIMEOUT_MS);
    const res = await p;
    expect(calls).toBe(1);
    expect(res.kept).toBe(5);
    expect(queued(store).find((e) => e.lotId === 'lot-1')?.attempts).toBe(2);
  });

  it('a refusal found later is reported and leaves the queue', async () => {
    const store = memoryStore();
    await bindNowOrQueue(store, async () => ({ ok: false, reason: BIND_TIMEOUT_REASON }), LOT, Date.now);
    vi.advanceTimersByTime(15_000);
    const res = await drainPendingBinds(store, async () => ({ ok: false, reason: 'sticker_code_already_used' }), Date.now);
    expect(res.refused.map((r) => [r.entry.lotCode, r.reason])).toEqual([['TST-000001', 'sticker_code_already_used']]);
    expect(queued(store)).toEqual([]);
  });

  it('gives up after MAX_BIND_ATTEMPTS and says so', async () => {
    const store = memoryStore();
    store.data[PENDING_BINDS_KEY] = JSON.stringify([
      { ...LOT, queuedAt: Date.now(), attempts: MAX_BIND_ATTEMPTS, nextAttemptAt: 0, lastReason: BIND_TIMEOUT_REASON },
    ]);
    const res = await drainPendingBinds(store, async () => ({ ok: true }), Date.now);
    expect(res.refused[0]?.reason).toMatch(/^gave_up_after_retries/);
    expect(queued(store)).toEqual([]);
  });

  it('keeps an entry queued while a drain was waiting on the network', async () => {
    const store = memoryStore();
    await bindNowOrQueue(store, async () => ({ ok: false, reason: 'Network request failed' }), LOT, Date.now);
    vi.advanceTimersByTime(15_000);
    let release: (v: { ok: true }) => void = () => {};
    const p = drainPendingBinds(store, () => new Promise((r) => (release = r)), Date.now);
    await vi.advanceTimersByTimeAsync(10);
    await bindNowOrQueue(store, async () => ({ ok: false, reason: 'Network request failed' }), { lotId: 'lot-2', lotCode: 'TST-000002', sticker: 'TEA0000002' }, Date.now);
    release({ ok: true });
    await p;
    expect(queued(store).map((e) => e.lotId)).toEqual(['lot-2']);
  });
});
