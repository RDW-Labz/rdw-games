// App wiring for lib/sticker-bind-queue.ts: bind a sticker after the save
// without the save waiting, and retry the ones bad wifi held back.
//
// The lotting screens call bindStickerAfterSave() and do NOT await it on
// their save path; app/_layout.tsx starts the drain once.

import { Alert, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { reportNonFatal } from '@/lib/session-watchdog';
import {
  bindNowOrQueue,
  drainPendingBinds,
  type BindFn,
  type BindOutcome,
} from '@/lib/sticker-bind-queue';
import { bindStickerToLot, STICKER_REASON_COPY } from './bindStickerToLot';

const bind: BindFn = (lotId, sticker) => bindStickerToLot(lotId, sticker);

/** One "wifi is slow" notice per this long, not one per lot. */
const QUEUED_NOTICE_EVERY_MS = 10 * 60_000;
let lastQueuedNoticeAt = 0;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export function stickerRefusalCopy(reason: string): string {
  return STICKER_REASON_COPY[reason] ?? `Couldn't bind sticker: ${reason}`;
}

function noteQueued(lotCode: string): void {
  const now = Date.now();
  if (now - lastQueuedNoticeAt < QUEUED_NOTICE_EVERY_MS) return;
  lastQueuedNoticeAt = now;
  Alert.alert(
    'Wifi is slow: sticker will attach shortly',
    `Lot ${lotCode} is saved and its scanned sticker is stored on this phone. It attaches by itself when the connection is back; keep lotting. Until then, scanning that sticker at put-away may not find the lot.`,
  );
}

function schedule(nextDueAt: number | null): void {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = null;
  if (nextDueAt === null) return;
  drainTimer = setTimeout(() => void drainNow(), Math.max(1_000, nextDueAt - Date.now()));
}

/** Retry the queued binds that are due. Never throws. */
export async function drainNow(): Promise<void> {
  try {
    const res = await drainPendingBinds(AsyncStorage, bind, Date.now);
    for (const { entry, reason } of res.refused) {
      // The screen that saved this lot may be long gone, so say it here.
      Alert.alert(
        'Sticker not attached',
        `${stickerRefusalCopy(reason.replace(/^gave_up_after_retries: /, ''))}\n\nLot ${entry.lotCode} is saved, but sticker ${entry.sticker} is NOT on it. Open ${entry.lotCode} in Inventory and scan a sticker.`,
      );
      reportNonFatal({
        message: `queued sticker bind failed [${reason}] lot=${entry.lotCode} attempts=${entry.attempts}`.slice(0, 500),
        screen: 'sticker-bind-queue',
        is_fatal: false,
      });
    }
    schedule(res.nextDueAt);
  } catch {
    // Diagnostics-grade: the next foreground or save tries again.
  }
}

/**
 * The bind after a save. One attempt of at most BIND_TIMEOUT_MS; a network
 * failure is queued and retried with backoff. Callers must not await this on
 * the save path. Never throws.
 */
export async function bindStickerAfterSave(input: {
  lotId: string;
  lotCode: string;
  sticker: string;
}): Promise<BindOutcome> {
  try {
    const outcome = await bindNowOrQueue(AsyncStorage, bind, input, Date.now);
    if (outcome.kind === 'queued') {
      noteQueued(input.lotCode);
      void drainNow(); // only (re)arms the timer: the new entry is not due yet
    } else if (outcome.kind === 'bound') {
      void drainNow(); // the network answered, so try anything held back
    }
    return outcome;
  } catch (err) {
    return { kind: 'refused', reason: (err as Error)?.message || 'unknown_error' };
  }
}

/** Once per JS context: retry on launch and whenever the app comes back. */
export function startStickerBindDrain(): void {
  if (started) return;
  started = true;
  void drainNow();
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void drainNow();
  });
}
