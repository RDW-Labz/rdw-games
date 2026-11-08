// My Bids reloaded on every bid on the platform, and never on being outbid
// (Realtime RLS hides other bidders' rows). These pin the new rules: reload
// only for her lots, and an older load never overwrites a newer one.

import { describe, it, expect } from 'vitest';
import {
  chunkIds,
  createLoadSequencer,
  createReloadDebouncer,
  lotSetKey,
  nextFireAt,
  shouldReloadForEvent,
} from './my-bids-realtime';

const ME = 'bidder-me';
const HER_LOTS = new Set(['lot-open', 'lot-won']);

describe('shouldReloadForEvent', () => {
  it('reloads when someone outbids her on one of her open lots (lots UPDATE)', () => {
    expect(
      shouldReloadForEvent(
        { table: 'lots', record: { id: 'lot-open', winner_bidder_id: 'someone-else' } as { id: string } },
        ME,
        HER_LOTS,
      ),
    ).toBe(true);
  });

  it('ignores a lots UPDATE on a lot she never bid on', () => {
    expect(shouldReloadForEvent({ table: 'lots', record: { id: 'lot-foreign' } }, ME, HER_LOTS)).toBe(false);
  });

  it('ignores a bids INSERT by someone else on a lot she never bid on', () => {
    expect(
      shouldReloadForEvent(
        { table: 'bids', record: { lot_id: 'lot-foreign', bidder_id: 'someone-else' } },
        ME,
        HER_LOTS,
      ),
    ).toBe(false);
  });

  it('reloads for her own new bid on a lot not yet in the list', () => {
    expect(
      shouldReloadForEvent({ table: 'bids', record: { lot_id: 'lot-brand-new', bidder_id: ME } }, ME, HER_LOTS),
    ).toBe(true);
  });

  it('reloads for any bid on one of her lots', () => {
    expect(
      shouldReloadForEvent({ table: 'bids', record: { lot_id: 'lot-open', bidder_id: 'someone-else' } }, ME, HER_LOTS),
    ).toBe(true);
  });

  it('ignores malformed payloads', () => {
    expect(shouldReloadForEvent({ table: 'lots', record: {} }, ME, HER_LOTS)).toBe(false);
    expect(shouldReloadForEvent({ table: 'bids', record: {} }, ME, HER_LOTS)).toBe(false);
  });
});

describe('chunkIds', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `lot-${i}`);

  it('0 ids → no filters', () => {
    expect(chunkIds([])).toEqual([]);
  });

  it('1 id → one filter', () => {
    expect(chunkIds(ids(1))).toEqual([['lot-0']]);
  });

  it('100 ids → one filter (the Realtime `in` max)', () => {
    const out = chunkIds(ids(100));
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(100);
  });

  it('101 ids → 100 + 1', () => {
    expect(chunkIds(ids(101)).map((c) => c.length)).toEqual([100, 1]);
  });

  it('451 ids (heaviest bidder) → 5 filters, none over 100, nothing lost', () => {
    const out = chunkIds(ids(451));
    expect(out.map((c) => c.length)).toEqual([100, 100, 100, 100, 51]);
    expect(out.flat()).toEqual(ids(451));
  });
});

describe('lotSetKey', () => {
  it('is order- and duplicate-insensitive, so re-renders do not churn channels', () => {
    expect(lotSetKey(['b', 'a', 'b'])).toBe(lotSetKey(['a', 'b']));
    expect(lotSetKey([])).toBe('');
  });
});

describe('createLoadSequencer', () => {
  it('a slower older load finishing after a newer one does not apply', async () => {
    const seq = createLoadSequencer();
    const applied: string[] = [];
    const run = async (name: string, ms: number) => {
      const isLatest = seq.begin();
      await new Promise((r) => setTimeout(r, ms));
      if (isLatest()) applied.push(name);
    };
    await Promise.all([run('older-slow', 30), run('newer-fast', 5)]);
    expect(applied).toEqual(['newer-fast']);
  });

  it('the latest load applies', () => {
    const seq = createLoadSequencer();
    const a = seq.begin();
    expect(a()).toBe(true);
    const b = seq.begin();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });
});

// Deterministic clock for the debouncer: timers fire only when advanced.
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimer: (h: unknown) => {
        timers.delete(h as number);
      },
    },
    advanceTo(t: number) {
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, x]) => x.at <= t)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = t;
    },
  };
}

describe('nextFireAt', () => {
  it('is 1.5s after the last event, capped at 5s after the first', () => {
    expect(nextFireAt(0, 0)).toBe(1500);
    expect(nextFireAt(0, 2000)).toBe(3500);
    expect(nextFireAt(0, 4000)).toBe(5000);
  });
});

describe('createReloadDebouncer', () => {
  it('a single event fires once at +1500ms', () => {
    const clock = fakeTimers();
    const fires: number[] = [];
    const d = createReloadDebouncer(() => fires.push(clock.timers.now()), clock.timers);
    d.schedule();
    clock.advanceTo(1499);
    expect(fires).toEqual([]);
    clock.advanceTo(10_000);
    expect(fires).toEqual([1500]);
  });

  it('events every 1000ms for 20s still fire at least every 5000ms (no starvation)', () => {
    const clock = fakeTimers();
    const fires: number[] = [];
    const d = createReloadDebouncer(() => fires.push(clock.timers.now()), clock.timers);
    for (let t = 0; t < 20_000; t += 1000) {
      clock.advanceTo(t);
      d.schedule();
    }
    clock.advanceTo(19_999);
    expect(fires.length).toBeGreaterThanOrEqual(3);
    let prev = 0;
    for (const f of fires) {
      expect(f - prev).toBeLessThanOrEqual(5000);
      prev = f;
    }
    expect(19_999 - prev).toBeLessThanOrEqual(5000);
  });

  it('a burst then quiet fires once', () => {
    const clock = fakeTimers();
    const fires: number[] = [];
    const d = createReloadDebouncer(() => fires.push(clock.timers.now()), clock.timers);
    for (const t of [0, 200, 400, 600]) {
      clock.advanceTo(t);
      d.schedule();
    }
    clock.advanceTo(60_000);
    expect(fires).toEqual([2100]);
  });

  it('cancel (blur) drops the pending reload', () => {
    const clock = fakeTimers();
    let fired = 0;
    const d = createReloadDebouncer(() => fired++, clock.timers);
    d.schedule();
    d.cancel();
    clock.advanceTo(60_000);
    expect(fired).toBe(0);
  });
});
