import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  count: 0,
  drains: 0,
  readFails: false,
  drainFails: false,
  drainFailed: 0,
  stall: false,
  release: null as (() => void) | null,
}));

vi.mock('./photo-upload-queue', () => ({
  photoQueueCount: async () => {
    if (state.readFails) throw new Error('photo_queue_read_failed');
    return state.count;
  },
  drainPhotoQueue: async () => {
    state.drains += 1;
    if (state.stall) {
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    }
    if (state.drainFails) throw new Error('offline');
    return { uploaded: 0, failed: state.drainFailed, uploadedUrls: [] };
  },
}));

import { startPhotoQueueRetry } from './photo-queue-retry';

describe('photo queue retry loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.count = 1;
    state.drains = 0;
    state.readFails = false;
    state.drainFails = false;
    state.drainFailed = 0;
    state.stall = false;
    state.release = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a non-empty queue on a timer without a foreground event', async () => {
    const stop = startPhotoQueueRetry(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(2);
    stop();
  });

  it('does not drain an empty queue', async () => {
    state.count = 0;
    const stop = startPhotoQueueRetry(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(state.drains).toBe(0);
    stop();
  });

  it('backs off after a failure and recovers afterwards', async () => {
    state.drainFails = true;
    const stop = startPhotoQueueRetry(1000, 4000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(1);

    // Failed: the next attempt waits 2s, not 1s.
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(2);

    // Failed again: 4s (the cap).
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.drains).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.drains).toBe(3);

    // Success resets the interval.
    state.drainFails = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(state.drains).toBe(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(5);
    stop();
  });

  it('backs off after a resolved drain that reports failed uploads', async () => {
    state.drainFailed = 1;
    const stop = startPhotoQueueRetry(1000, 4000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(1);

    // failed>0 resolves rather than throwing; it must still back off.
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(2);

    state.drainFailed = 0;
    await vi.advanceTimersByTimeAsync(4000);
    expect(state.drains).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(4);
    stop();
  });

  it('keeps at most one retry in flight while a drain stalls', async () => {
    state.stall = true;
    const stop = startPhotoQueueRetry(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(1);

    // Many intervals pass during the stalled drain; no overlapping attempts.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.drains).toBe(1);

    state.release?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.drains).toBe(2);
    stop();
  });

  it('stops after the returned cleanup runs', async () => {
    const stop = startPhotoQueueRetry(1000);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.drains).toBe(0);
  });
});
