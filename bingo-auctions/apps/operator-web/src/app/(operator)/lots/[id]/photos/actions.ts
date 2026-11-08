'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { upsertPhotoToCatalog } from '@/lib/catalog/upsert-photo-to-catalog';
import type { IdentifierKind } from '@/lib/catalog/upsert-photo-to-catalog';

const saveSchema = z.object({
  lotId: z.string().uuid(),
  photoUrls: z.array(z.string().url()).max(20),
});

export async function savePhotoOrder(input: z.infer<typeof saveSchema>) {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  const supabase = await getSupabaseServer();
  const { error } = await supabase
    .from('lots')
    .update({ photo_urls: parsed.data.photoUrls })
    .eq('id', parsed.data.lotId);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath(`/lots/${parsed.data.lotId}`);
  revalidatePath(`/lots/${parsed.data.lotId}/photos`);

  // Cross-operator catalog warming (fire-and-forget).
  // Fetch the lot's identifier columns, then upsert every photo URL that
  // has a known identifier into product_lookups so future operators scanning
  // the same UPC/ASIN get these photos for free. Runs after the lot write
  // is committed — a catalog failure never blocks the operator.
  warmCatalogFromPhotoSave(parsed.data.lotId, parsed.data.photoUrls).catch(
    (err: unknown) => {
      console.warn(
        '[savePhotoOrder] catalog warm failed (non-fatal):',
        (err as Error)?.message,
      );
    },
  );

  return { ok: true as const };
}

/**
 * Asynchronously writes each photo URL from a lot photo-order save back into
 * product_lookups so it benefits every operator scanning the same identifier.
 *
 * Fire-and-forget from savePhotoOrder — must never throw; caller wraps in .catch().
 */
async function warmCatalogFromPhotoSave(
  lotId: string,
  photoUrls: string[],
): Promise<void> {
  if (photoUrls.length === 0) return;

  // Fetch the lot's identifier columns using the server (RLS-scoped) client.
  // We only need to read — the actual catalog write uses the admin client.
  const supabase = await getSupabaseServer();
  const { data: lot } = await supabase
    .from('lots')
    .select('upc, asin, operator_id')
    .eq('id', lotId)
    .maybeSingle<{ upc: string | null; asin: string | null; operator_id: string }>();

  if (!lot) return;

  // Resolve the best available identifier for the catalog key.
  // Priority: ASIN > UPC (mirrors image-enrichment-drain priority order).
  let identifierKind: IdentifierKind | null = null;
  let identifierValue = '';

  if (lot.asin && lot.asin.trim().length > 0) {
    identifierKind = 'asin';
    identifierValue = lot.asin.trim().toUpperCase();
  } else if (lot.upc && lot.upc.trim().length > 0) {
    const upcRaw = lot.upc.trim();
    // Honor the existing convention: if the upc column holds 'asin:B0...'
    // (imported from catalog), treat it as an ASIN.
    if (upcRaw.startsWith('asin:')) {
      identifierKind = 'asin';
      identifierValue = upcRaw.slice(5).toUpperCase();
    } else {
      identifierKind = 'upc';
      identifierValue = upcRaw;
    }
  }

  // No recognisable identifier — nothing to index in the catalog.
  if (!identifierKind || !identifierValue) return;

  const admin = getSupabaseAdmin();

  // Upsert every URL from the new photo order. The helper is idempotent
  // so calling it multiple times for the same URL is safe.
  for (const url of photoUrls) {
    await upsertPhotoToCatalog({
      admin,
      identifierKind,
      identifierValue,
      photoUrl: url,
      source: 'staff_photo',
      contributedByOperatorId: lot.operator_id,
    });
  }
}
