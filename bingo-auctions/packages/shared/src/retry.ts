// Bounded async retry with a per-attempt timeout.
//
// Why this exists: a mobile client cannot tell "the server said no" from "the
// request never came back" when the call just hangs. `useOperatorRole` sat on
// its initial `loading` state forever after a dropped connection because a
// failed query returned without setting state, and a hung request never even
// got that far. The field report (#770) is a phone stuck on "Loading…" with no
// way out except a force-quit, so the role check now needs a hard bound and a
// visible retry instead of an open-ended await.
//
// This helper is deliberately pure: it takes a function and returns a
// discriminated result, never throws, and owns no timers after it settles. The
// caller decides what an exhausted retry means (an error screen, a fallback,
// keeping a previously-known value).
//
// It is NOT a replacement for the durable, persisted queues in field-mobile
// (photo uploads, sticker binds). Those survive process death and retry for
// minutes; this bounds one interactive request.

/** Error used when a single attempt exceeds `timeoutMs`. */
export class AttemptTimeoutError extends Error {
  override readonly name = 'AttemptTimeoutError';

  constructor(readonly timeoutMs: number) {
    super(`Attempt timed out after ${timeoutMs}ms`);
  }
}

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** First backoff delay in ms. Default 250. */
  baseDelayMs?: number;
  /** Backoff cap in ms. Default 2_000. */
  maxDelayMs?: number;
  /** Per-attempt timeout in ms. 0 or negative disables the timeout. Default 8_000. */
  timeoutMs?: number;
  /** External cancellation. Once aborted no further attempt starts. */
  signal?: AbortSignal;
  /** Return false to stop retrying a particular error immediately. Default: retry all. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: unknown; attempts: number; timedOut: boolean };

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type AttemptOutcome<T> =
  | { ok: true; value: T; timedOut: boolean }
  | { ok: false; error: unknown; timedOut: boolean };

/**
 * Run `fn` up to `attempts` times, with exponential backoff between failures
 * and an optional per-attempt timeout. Resolves — never rejects — with the
 * first success or the last error.
 *
 * `fn` receives the 1-based attempt number and a signal that aborts when that
 * attempt's timeout fires (pass it to Supabase's `.abortSignal()` so a slow
 * query is actually cancelled rather than merely ignored).
 */
export async function runWithRetry<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  opts: RetryOptions = {},
): Promise<RetryResult<T>> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 2_000);
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown;
  let timedOut = false;
  let used = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    used = attempt;
    if (opts.signal?.aborted) {
      return { ok: false, error: abortError(), attempts: used, timedOut };
    }

    const attemptResult = await runAttempt(fn, attempt, timeoutMs, opts.signal);

    if (attemptResult.ok) {
      return { ok: true, value: attemptResult.value, attempts: used };
    }

    lastError = attemptResult.error;
    if (attemptResult.timedOut) timedOut = true;
    if (opts.signal?.aborted) {
      return { ok: false, error: abortError(), attempts: used, timedOut };
    }
    // A predicate that throws is itself a failure, not a reason to reject the
    // whole helper. Report the predicate error and stop retrying.
    if (attempt < attempts) {
      let retry: boolean;
      try {
        retry = shouldRetry(attemptResult.error, attempt);
      } catch (predicateError) {
        return { ok: false, error: predicateError, attempts: used, timedOut };
      }
      if (!retry) break;
    } else {
      break;
    }
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    try {
      await delay(backoff, opts.signal);
    } catch (delayError) {
      return { ok: false, error: delayError, attempts: used, timedOut };
    }
  }

  return { ok: false, error: lastError, attempts: used, timedOut };
}

/**
 * One bounded attempt. Resolves to either a value or an error; it never rejects
 * and always clears its timer/listeners before settling.
 */
async function runAttempt<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  attempt: number,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<AttemptOutcome<T>> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let attemptTimedOut = false;

  let run: Promise<T>;
  try {
    run = fn(attempt, controller.signal);
  } catch (error) {
    // `fn` is documented as async, but a synchronous throw must still become a
    // normal failure result: otherwise the helper rejects and leaks the abort
    // listener added above.
    externalSignal?.removeEventListener('abort', onExternalAbort);
    return { ok: false, error, timedOut: false };
  }
  // If the timeout/abort wins the race and the attempt later rejects (an
  // aborted fetch commonly does), nobody is left awaiting `run`. Mark it
  // handled so that rejection cannot surface as an unhandled rejection.
  void run.catch(() => {});

  let cleanup = () => {};

  const timeout =
    timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            attemptTimedOut = true;
            controller.abort();
            reject(new AttemptTimeoutError(timeoutMs));
          }, timeoutMs);
        })
      : null;

  const abort = new Promise<never>((_, reject) => {
    const onAbort = () => reject(abortError());
    if (externalSignal?.aborted) {
      onAbort();
      return;
    }
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    // The listener is removed in the finally block below; a once-listener that
    // fired is already gone.
    cleanup = () => externalSignal?.removeEventListener('abort', onAbort);
  });
  try {
    const racers: Promise<T>[] = [run];
    if (timeout) racers.push(timeout);
    racers.push(abort);
    const value = await Promise.race(racers);
    return { ok: true, value, timedOut: attemptTimedOut };
  } catch (error) {
    return { ok: false, error, timedOut: attemptTimedOut };
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    cleanup();
  }
}
