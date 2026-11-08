// Did the last OTA this phone downloaded actually launch? Pure decision half;
// the side effects live in session-watchdog.ts.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// 2026-09-22: every OTA since August shipped without its Supabase env (#365).
// Each one threw at import, expo-updates rolled the phone back to its built-in
// bundle, and NOTHING reported it — the crash happened before any reporter was
// armed, and the rollback is silent by design. Weeks of fixes reached no one.
//
// The rollback leaves exactly one trace JS can see: the bundle this launch runs
// is not the one the previous session finished downloading. The previous
// session records the downloaded id; the next launch compares. A mismatch means
// the update was downloaded and then refused — it crashed on launch, or failed
// verification — and that is worth a report every single time.

/** What the previous session recorded when an update finished downloading. */
export interface DownloadedMark {
  updateId: string;
  /** When the download finished, epoch ms. */
  at: number;
}

export interface OtaHealthInput {
  /** From storage; null when no download was recorded since the last check. */
  downloaded: DownloadedMark | null;
  /** Updates.updateId of THIS launch; null in dev / embedded-without-manifest. */
  runningId: string | null;
  isEmergencyLaunch: boolean;
  emergencyLaunchReason: string | null;
}

/**
 * Returns a report message when this launch shows an update was refused, or
 * null when all is well. Callers clear the stored mark after calling, so each
 * refusal is reported once.
 */
export function otaHealthMessage(input: OtaHealthInput): string | null {
  const { downloaded, runningId, isEmergencyLaunch, emergencyLaunchReason } = input;

  // expo-updates' own statement that it could not launch the chosen update.
  if (isEmergencyLaunch) {
    const reason = (emergencyLaunchReason ?? 'no reason given').slice(0, 300);
    return `ota emergency launch — running built-in bundle: ${reason}`;
  }

  if (!downloaded?.updateId) return null;
  if (downloaded.updateId === runningId) return null;

  return (
    `ota refused — update ${downloaded.updateId} finished downloading but this ` +
    `launch runs ${runningId ?? 'embedded'} (crashed on launch or failed to load)`
  );
}

/** Parse the stored mark defensively: a kill mid-write can leave anything. */
export function parseDownloadedMark(raw: string | null): DownloadedMark | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DownloadedMark>;
    return typeof v?.updateId === 'string' && v.updateId.length > 0
      ? { updateId: v.updateId, at: typeof v.at === 'number' ? v.at : 0 }
      : null;
  } catch {
    return null;
  }
}
