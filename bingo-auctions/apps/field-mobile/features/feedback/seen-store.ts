// When each worker last looked at their own reports.
//
// Used to decide whether the home screen says "Report a bug" or "2 of your
// reports were fixed". Local to the device on purpose: this is a read receipt
// for a nudge, not a fact about the business, and a column on app_feedback
// would need a write path from a shared station account that RLS correctly
// refuses.
//
// Keyed by worker name because the app signs in per DEVICE and identifies the
// human by PIN — one iPhone carries several people through a shift, and each
// of them should get their own badge rather than clearing it for the others.

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'bingo:feedback-seen:';

function keyFor(reporterLabel: string): string {
  return `${PREFIX}${reporterLabel.trim().toLowerCase()}`;
}

/** ISO timestamp of their last look, or null if they have never looked. */
export async function getLastSeen(
  reporterLabel: string | null | undefined,
): Promise<string | null> {
  const label = reporterLabel?.trim();
  if (!label) return null;
  try {
    return await AsyncStorage.getItem(keyFor(label));
  } catch {
    // Storage unavailable — treat as "never looked". The badge shows once more
    // than it should, which is the harmless direction: the failure that costs
    // something is a fix nobody hears about.
    return null;
  }
}

/** Record that they have now seen everything resolved up to this moment. */
export async function markSeen(
  reporterLabel: string | null | undefined,
  at: Date = new Date(),
): Promise<void> {
  const label = reporterLabel?.trim();
  if (!label) return;
  try {
    await AsyncStorage.setItem(keyFor(label), at.toISOString());
  } catch {
    // Never surface this. Failing to remember a read receipt must not break
    // the screen the worker is standing in front of.
  }
}
