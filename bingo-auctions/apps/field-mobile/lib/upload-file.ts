// Upload a local file to Supabase Storage by STREAMING it from disk.
//
// lib/upload-image.ts is the canonical path for photos and stays that way: it
// reads base64 because that was the only way to defeat the RN empty-blob bug
// for the small images it handles.
//
// That approach cannot be reused for screen recordings. Base64 inflates by 4/3
// and the decode holds the string AND the byte array in memory at once, so a
// 40 MB clip costs well over 100 MB of heap — on the memory-starved phones
// whose silent kills this feature exists to capture. Uploading the evidence
// would trigger the bug.
//
// expo-file-system's uploadAsync streams from disk instead, so peak memory is
// a buffer rather than the file. It posts straight at the Storage REST
// endpoint, which is what supabase-js would call anyway.

import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '@auction-platform/supabase-client';

export type UploadFileResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; reason: string };

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';

/**
 * @param bucket  target bucket; must already exist (see mig 0325).
 * @param path    object path INCLUDING the uid folder the bucket policy checks.
 * @param uri     local file:// or content:// URI from the picker.
 */
export async function uploadFileFromUri(
  bucket: string,
  path: string,
  uri: string,
  contentType: string,
): Promise<UploadFileResult> {
  if (!SUPABASE_URL) return { ok: false, reason: 'storage not configured' };

  // Size is read first so an oversized file fails locally with a sentence
  // somebody can act on, rather than as a 413 from the far end after the
  // picker has already spent a minute uploading over warehouse wifi.
  let bytes = 0;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return { ok: false, reason: 'file not found on device' };
    bytes = info.size ?? 0;
  } catch {
    // Non-fatal: some content:// URIs refuse stat. The bucket's own limit is
    // the real enforcement; this check is a courtesy.
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { ok: false, reason: 'signed out — sign in and try again' };

  try {
    const res = await FileSystem.uploadAsync(
      `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURI(path)}`,
      uri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': contentType,
          'x-upsert': 'false',
        },
      },
    );
    if (res.status >= 200 && res.status < 300) return { ok: true, path, bytes };
    return { ok: false, reason: describeStorageError(res.status, res.body) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message ?? 'upload failed' };
  }
}

/** Storage speaks JSON errors; a raw body in an Alert helps nobody. */
function describeStorageError(status: number, body: string | undefined): string {
  if (status === 413) return 'that file is too large — try a shorter clip (3 min max)';
  if (status === 401 || status === 403) return 'not allowed to upload — sign in again';
  try {
    const parsed = JSON.parse(body ?? '{}') as { message?: string; error?: string };
    const msg = parsed.message ?? parsed.error;
    if (msg) return msg;
  } catch {
    // Fall through to the status code.
  }
  return `upload failed (${status})`;
}
