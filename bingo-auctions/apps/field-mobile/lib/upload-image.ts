// Reliable image upload to Supabase Storage from a local file:// or
// content:// URI on iOS / Android.
//
// Background: every photo uploaded with the old pattern
// `await (await fetch(localUri)).blob()` ended up as a 0-byte object in
// Storage. Supabase accepts the PUT with 200, but the request body is
// empty. This is a known Expo iOS bug -- the React Native fetch +
// Blob() chain produces an empty blob for local file URIs.
//
// Fix: read the file as base64 via expo-file-system (the only RN-side
// API that reliably returns the actual bytes), decode to a Uint8Array,
// and hand THAT to supabase-js (which uses the raw bytes as the PUT
// body).
//
// Audit on 2026-05-13 found 17 of 17 lifetime uploads to `lot-photos`
// were 0-byte. This helper is the canonical fix; new upload sites
// should call it instead of rolling their own fetch+blob.

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

    // atob is available in RN runtime since 0.74 (we ship 0.81).
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

  const uploadOpts: Parameters<typeof supabase.storage.from>[0] extends string
    ? Parameters<ReturnType<typeof supabase.storage.from>['upload']>[2]
    : never = {
    contentType: opts?.contentType ?? 'image/jpeg',
    upsert: opts?.upsert ?? false,
    ...(opts?.cacheControl ? { cacheControl: opts.cacheControl } : {}),
  };

  const { error } = await supabase.storage.from(bucket).upload(path, bytes, uploadOpts);
  if (error) {
    return { ok: false, reason: friendlyStorageError(error.message) };
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  if (!data.publicUrl) {
    return { ok: false, reason: 'no public URL returned from getPublicUrl' };
  }

  return { ok: true, url: data.publicUrl, bytes: bytes.byteLength };
}

// Translate raw Storage error messages into something the operator can
// act on. Most callers surface this in a Toast or Alert; raw Supabase
// errors like "new row violates row-level security policy" are scary
// and unactionable.
function friendlyStorageError(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes('row-level security') || r.includes('row level security')) {
    return 'Permission check failed — sign out and back in, then retry.';
  }
  if (r.includes('payload too large') || r.includes('413')) {
    return 'Photo is too large. Try again — the app will compress it.';
  }
  if (r.includes('network') || r.includes('fetch failed') || r.includes('timeout')) {
    return 'Network hiccup — check signal and retry.';
  }
  return raw.slice(0, 80);
}
