'use server';

// Server actions for the FeaturedImagesCurator component.
//
// Two operations:
//   autoPickFeaturedImages(auctionId, excludeUrls?) → string[]
//     Calls the auto_pick_featured_images RPC and writes the result back
//     to auctions.featured_image_urls in the same transaction. Returns
//     the persisted URLs so the UI can render them. Excluded URLs let
//     the "swap this one" flow iterate without picking the same image.
//
//   saveFeaturedImages(auctionId, urls) → void
//     Direct overwrite for manual edits (drag-reorder, delete one,
//     paste a custom URL). The DB trigger from migration 0051 strips
//     anything that fails is_safe_image_url so we don't have to filter
//     here — but we do cap to 6 to match the CHECK constraint.
//
// Both auth-check via supabase.auth.getUser; RLS + the RPC's own
// operator-match guard handle authorization.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

const autoPickSchema = z.object({
  auctionId: z.string().uuid(),
  excludeUrls: z.array(z.string()).max(20).optional(),
});

export type AutoPickResult =
  | { ok: true; urls: string[] }
  | { ok: false; error: string };

export async function autoPickFeaturedImages(
  input: z.infer<typeof autoPickSchema>,
): Promise<AutoPickResult> {
  const parsed = autoPickSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data: rpcOut, error: rpcErr } = await supabase.rpc('auto_pick_featured_images', {
    p_auction_id: parsed.data.auctionId,
    p_limit: 6,
    p_exclude_urls: parsed.data.excludeUrls ?? [],
  });
  if (rpcErr) return { ok: false, error: rpcErr.message };

  const urls = Array.isArray(rpcOut) ? (rpcOut as string[]) : [];
  if (urls.length === 0) {
    // No qualifying lots — return empty without touching the row so
    // existing manual selections aren't clobbered by an empty auto-pick.
    return { ok: true, urls: [] };
  }

  // Persist. The 0051 trigger filters unsafe URLs as a backstop; the
  // RPC has already prefiltered. CHECK constraint enforces ≤6.
  const { error: upErr } = await supabase
    .from('auctions')
    .update({ featured_image_urls: urls })
    .eq('id', parsed.data.auctionId);
  if (upErr) return { ok: false, error: upErr.message };

  revalidatePath(`/auctions/${parsed.data.auctionId}`);
  revalidatePath('/auctions');
  return { ok: true, urls };
}

const saveSchema = z.object({
  auctionId: z.string().uuid(),
  // Cap on the client side too. The DB CHECK enforces 6; we accept up
  // to 6 here so a malformed POST gets a clean 400, not a 500.
  urls: z.array(z.string()).max(6),
});

export type SaveResult = { ok: true } | { ok: false; error: string };

export async function saveFeaturedImages(
  input: z.infer<typeof saveSchema>,
): Promise<SaveResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { error: upErr } = await supabase
    .from('auctions')
    .update({ featured_image_urls: parsed.data.urls })
    .eq('id', parsed.data.auctionId);
  if (upErr) return { ok: false, error: upErr.message };

  revalidatePath(`/auctions/${parsed.data.auctionId}`);
  revalidatePath('/auctions');
  return { ok: true };
}
