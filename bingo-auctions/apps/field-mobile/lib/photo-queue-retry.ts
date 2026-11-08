import { drainPhotoQueue, photoQueueCount } from './photo-upload-queue';

/**
 * How often a non-empty queue is retried while the app stays open. Without a
 * timer a failed upload only retried on the next capture or foreground, so a
 * phone that stayed on the inventory screen sat idle after service returned.
 */
export const PHOTO_QUEUE_RETRY_MS = 30_000;

/** Upper bound for the failure backoff. */
export const PHOTO_QUEUE_RETRY_MAX_MS = 5 * 60_000;

/**
 * Start the retry loop. Returns a stop function.
 *
 * Only one attempt is ever in flight, and the next timer is scheduled when the
 * previous attempt settles. A `setInterval` fired every tick even while a drain
 * was stalled, so a backlog accumulated overlapping requests; this also lets a
 * failing connection back off instead of hammering it every 30s.
 */
export function startPhotoQueueRetry(
  intervalMs = PHOTO_QUEUE_RETRY_MS,
  maxMs = PHOTO_QUEUE_RETRY_MAX_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = intervalMs;

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
  };

  const tick = () => {
    timer = null;
    if (stopped) return;
    void (async () => {
      let failed = false;
      try {
        if ((await photoQueueCount()) > 0) {
          // A drain resolves with failed>0 when uploads or patches failed; it
          // does not throw. Treating that as success reset the timer to 30s
          // forever instead of backing off (RED TEAM #683 MEDIUM).
          const result = await drainPhotoQueue();
          if (result.failed > 0) failed = true;
        }
      } catch {
        // Storage or network is still unavailable; back off and retry.
        failed = true;
      }
      if (stopped) return;
      if (failed) {
        delay = Math.min(delay * 2, maxMs);
      } else {
        delay = intervalMs;
      }
      schedule(delay);
    })();
  };

  schedule(intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
