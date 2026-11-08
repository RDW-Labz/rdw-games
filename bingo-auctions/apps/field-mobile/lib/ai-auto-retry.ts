/** Max automatic AI rescans when returning from background (per hero photo). */
export const MAX_AI_AUTO_RETRIES = 2;

/** Whether another AppState background→active auto-retry may run. */
export function canAutoRetryAi(autoRetriesUsed: number): boolean {
  return autoRetriesUsed < MAX_AI_AUTO_RETRIES;
}

export function bumpAutoRetryCount(autoRetriesUsed: number): number {
  return autoRetriesUsed + 1;
}

export function resetAutoRetryCount(): number {
  return 0;
}
