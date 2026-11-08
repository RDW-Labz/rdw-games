/**
 * Append photo URLs without dropping concurrent additions or duplicating.
 *
 * Background captures finish at unpredictable times; rebuilding the strip from
 * a render-time snapshot erased a photo another capture or another device had
 * already added. Always merge into the current list instead.
 */
export function mergePhotoUrls(current: string[], added: string[]): string[] {
  const merged = [...current];
  for (const url of added) {
    if (url && !merged.includes(url)) merged.push(url);
  }
  return merged;
}

/** Same local-URI rule as `isLocalPhotoUri`, kept dependency-free for tests. */
function isLocal(uri: string): boolean {
  return !/^https:\/\//i.test(uri.trim());
}

/**
 * Reconcile the strip after a Save whose upload started from `uploadedFrom`.
 *
 * Only photos present when the Save began were uploaded and replaced by public
 * URLs. A photo added while the request was in flight is still local and was
 * never sent, so it must stay visible (and dirty) instead of being dropped by
 * a blanket "remove every local URI" (RED TEAM #683 HIGH).
 */
export function mergePhotosAfterSave(
  current: readonly string[],
  uploadedFrom: readonly string[],
  saved: readonly string[],
): string[] {
  const uploadedLocals = new Set(uploadedFrom.filter(isLocal));
  const pendingLocals = current.filter((url) => isLocal(url) && !uploadedLocals.has(url));
  const concurrentRemotes = current.filter((url) => !isLocal(url));
  return mergePhotoUrls([...saved], [...concurrentRemotes, ...pendingLocals]);
}
