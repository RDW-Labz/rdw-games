import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttemptTimeoutError, runWithRetry } from './retry';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runWithRetry', () => {
  it('returns the first success without waiting', async () => {
    const fn = vi.fn(async () => 'ok');

    const result = await runWithRetry(fn);

    expect(result).toEqual({ ok: true, value: 'ok', attempts: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds on the third attempt', async () => {
    let calls = 0;
    const fn = vi.fn(async (attempt: number) => {
      calls = attempt;
      if (attempt < 3) throw new Error(`attempt ${attempt} failed`);
      return 'recovered';
    });

    const pending = runWithRetry(fn, { attempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result).toEqual({ ok: true, value: 'recovered', attempts: 3 });
    expect(calls).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('waits the exponential backoff between attempts', async () => {
    const fn = vi.fn(async () => {
      throw new Error('down');
    });

    const pending = runWithRetry(fn, { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 2_000 });

    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    // Second backoff is capped at maxDelayMs (2_000), not 2_000 * 2.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(3);
      expect((result.error as Error).message).toBe('down');
    }
  });

  it('bounds a hung attempt with the per-attempt timeout and retries', async () => {
    const fn = vi.fn(async () => new Promise<string>(() => {}));

    const pending = runWithRetry(fn, { attempts: 2, timeoutMs: 1_000, baseDelayMs: 10 });
    // Two 1s attempt timeouts plus the 10ms backoff between them.
    await vi.advanceTimersByTimeAsync(2_020);
    const result = await pending;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
      expect(result.attempts).toBe(2);
      expect(result.error).toBeInstanceOf(AttemptTimeoutError);
    }
  });

  it('passes an aborting signal to the attempt when the timeout fires', async () => {
    let captured: AbortSignal | null = null;
    const fn = vi.fn(async (_attempt: number, signal: AbortSignal) => {
      captured = signal;
      return new Promise<string>(() => {});
    });

    const pending = runWithRetry(fn, { attempts: 1, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(captured).not.toBeNull();
    expect(captured!.aborted).toBe(true);
  });

  it('stops immediately when shouldRetry returns false', async () => {
    const fn = vi.fn(async () => {
      throw new Error('permanent');
    });
    const shouldRetry = vi.fn(() => false);

    const result = await runWithRetry(fn, { attempts: 5, shouldRetry });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as Error).message).toBe('permanent');
  });

  it('does not start another attempt after external cancellation', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => new Promise<string>(() => {}));

    const pending = runWithRetry(fn, { attempts: 4, timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).name).toBe('AbortError');
    }
  });

  it('clamps attempts to at least one', async () => {
    const fn = vi.fn(async () => 'once');

    const result = await runWithRetry(fn, { attempts: 0 });

    expect(result).toEqual({ ok: true, value: 'once', attempts: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('turns a synchronous callback throw into a failure result and removes its abort listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const fn = vi.fn((_attempt: number, _signal: AbortSignal): Promise<string> => {
      throw new Error('sync boom');
    });

    const result = await runWithRetry(fn, { attempts: 1, signal: controller.signal });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.timedOut).toBe(false);
      expect((result.error as Error).message).toBe('sync boom');
    }
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('turns a throwing shouldRetry predicate into a failure result instead of escaping', async () => {
    const fn = vi.fn(async () => {
      throw new Error('attempt failed');
    });
    const shouldRetry = vi.fn(() => {
      throw new Error('predicate blew up');
    });

    const result = await runWithRetry(fn, { attempts: 5, shouldRetry });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(1);
      expect((result.error as Error).message).toBe('predicate blew up');
    }
  });
});
