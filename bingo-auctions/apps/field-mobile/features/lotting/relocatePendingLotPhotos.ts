// Best-effort: after a lot is created, COPY its "_pending" photos into the
// lot's own {lotCode}/ folder, repoint photo_urls, then delete the originals.
// COPY (not move) means the _pending objects stay valid until photo_urls is
// successfully repointed — a failure at any step can NEVER break a photo_url.
import type { SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'lot-photos';
const PUBLIC_MARKER = `/storage/v1/object/public/${BUCKET}/`;

export async function relocatePendingLotPhotos(
  supabase: SupabaseClient,
  lotId: string,
  operatorId: string,
  lotCode: string,
  photoUrls: readonly string[],
): Promise<void> {
  try {
    const code = lotCode?.trim();
    if (!code || photoUrls.length === 0) return;
    const pendingPrefix = `${operatorId}/_pending/`;
    const copiedSrc: string[] = [];
    const next: string[] = [];
    for (const url of photoUrls) {
      const i = url.indexOf(PUBLIC_MARKER);
      if (i === -1) { next.push(url); continue; }
      const src = url.slice(i + PUBLIC_MARKER.length); // {operatorId}/_pending/{file}
      if (!src.startsWith(pendingPrefix)) { next.push(url); continue; }
      const dest = `${operatorId}/${code}/${src.slice(pendingPrefix.length)}`;
      const { error } = await supabase.storage.from(BUCKET).copy(src, dest);
      if (error) { next.push(url); continue; }            // keep original (src still valid)
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(dest);
      if (!data?.publicUrl) { next.push(url); continue; }
      next.push(data.publicUrl);
      copiedSrc.push(src);
    }
    if (copiedSrc.length === 0) return;                    // nothing relocated
    const { error: upErr } = await supabase.from('lots').update({ photo_urls: next }).eq('id', lotId);
    if (upErr) return;                                     // photo_urls still points to valid _pending objects
    await supabase.storage.from(BUCKET).remove(copiedSrc); // best-effort cleanup of orphans
  } catch {
    // best-effort; the lot already has working photo URLs
  }
}
