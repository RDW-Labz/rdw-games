// Copy a captured photo from the cache into the app's Documents directory.
// Cache files are reclaimed by iOS while the app is backgrounded; a draft
// that points at a deleted cache file restores with a missing photo.
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isLocalPhotoUri } from '@/features/lotting/uploadPendingPhotos';
import { PHOTO_QUEUE_KEY } from './photo-queue-key';

const DIR = `${FileSystem.documentDirectory}lot-photos/`;

export async function persistPhoto(uri: string): Promise<string> {
  if (!isLocalPhotoUri(uri)) return uri;
  try {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const dest = `${DIR}${name}`;
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  } catch {
    return uri;
  }
}

export async function deletePersistedPhoto(uri: string): Promise<void> {
  if (!uri.startsWith(DIR)) return;
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

/** True when the local file is still on disk; fail open so a photo is never
 * dropped just because the filesystem could not answer. */
export async function persistedPhotoExists(uri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return Boolean(info.exists);
  } catch {
    return true;
  }
}

/**
 * Local files that the upload queue still needs. Returns null when the queue
 * cannot be read, because pruning must never guess: a transient read error or
 * corrupt JSON would otherwise delete files that are still queued to upload.
 */
async function queuedPhotoUris(): Promise<Set<string> | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(PHOTO_QUEUE_KEY);
  } catch {
    return null;
  }
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const uris = new Set<string>();
    for (const entry of parsed) {
      const uri = (entry as { localUri?: unknown } | null)?.localUri;
      if (typeof uri === 'string' && uri) uris.add(uri);
    }
    return uris;
  } catch {
    return null;
  }
}

/** Delete old Documents copies that no saved draft or queued upload references. */
export async function prunePersistedPhotos(now = Date.now()): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(DIR);
    if (!info.exists) return;
    const queued = await queuedPhotoUris();
    if (!queued) return;
    const files = await FileSystem.readDirectoryAsync(DIR);
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith('lotting:draft:'));
    const drafts = await AsyncStorage.multiGet(keys);
    const referenced = new Set<string>();
    for (const [, raw] of drafts) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { draft?: unknown };
        const text = JSON.stringify(parsed.draft ?? '');
        for (const match of text.matchAll(/file:\/\/\/[^"\\]+/g)) referenced.add(match[0]);
      } catch {
        /* ignore */
      }
    }
    for (const name of files) {
      const uri = `${DIR}${name}`;
      if (referenced.has(uri) || queued.has(uri)) continue;
      const stat = await FileSystem.getInfoAsync(uri);
      const modified = stat.exists && !stat.isDirectory ? (stat.modificationTime ?? 0) : 0;
      if (now - modified * 1000 > 7 * 24 * 60 * 60 * 1000) await deletePersistedPhoto(uri);
    }
  } catch {
    /* best effort */
  }
}
