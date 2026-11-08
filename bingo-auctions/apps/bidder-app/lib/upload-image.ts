// Reliable image upload to Supabase Storage from a local file:// URI.
// See apps/field-mobile/lib/upload-image.ts for the full rationale.
//
// Short version: `fetch(localFileUri).blob()` returns a 0-byte blob on
// Expo iOS. Use expo-file-system to read base64 + decode to Uint8Array,
// upload THAT.

import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '@auction-platform/supabase-client';

export type UploadResult =
  | { ok: true; url: string; bytes: number }
  | { ok: false; reason: string };

export async function uploadImageFromUri(
  bucket: string,
  path: string,
  uri: string,
  opts?: {
    contentType?: string;
    upsert?: boolean;
    cacheControl?: string;
  },
): Promise<UploadResult> {
  let bytes: Uint8Array;
  try {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (!base64) return { ok: false, reason: 'file read returned empty base64' };

    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch (err) {
    return {
      ok: false,
      reason: `file read failed: ${(err as Error).message ?? 'unknown'}`,
    };
  }

  if (bytes.byteLength === 0) {
    return { ok: false, reason: 'file decoded to 0 bytes' };
  }

  const { error } = await supabase.storage.from(bucket).upload(path, bytes, {
    contentType: opts?.contentType ?? 'image/jpeg',
    upsert: opts?.upsert ?? false,
    ...(opts?.cacheControl ? { cacheControl: opts.cacheControl } : {}),
  });
  if (error) return { ok: false, reason: error.message };

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  if (!data.publicUrl) return { ok: false, reason: 'no public URL returned' };

  return { ok: true, url: data.publicUrl, bytes: bytes.byteLength };
}
