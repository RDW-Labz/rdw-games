'use server';

// Server actions for /profile/saved-searches.
// Operates on saved_searches via RLS policy saved_searches_self_all (mig 0019:49-52)
// which covers ALL operations (SELECT, INSERT, UPDATE, DELETE) where
// bidder_id = auth.uid().

import { revalidatePath } from 'next/cache';
import { getSupabaseServer } from '@/lib/supabase-server';

type Result = { ok: true } | { ok: false; error: string };

// Delete a saved search. RLS restricts deletes to the calling bidder's own
// rows (bidder_id = auth.uid()), so a mismatched id silently no-ops rather
// than deleting another bidder's data.
export async function deleteSavedSearch(id: string): Promise<Result> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'invalid_id' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { error } = await supabase
    .from('saved_searches')
    .delete()
    .eq('id', id)
    .eq('bidder_id', user.id); // belt-and-braces; RLS also enforces this

  if (error) return { ok: false, error: error.message };

  revalidatePath('/profile/saved-searches');
  return { ok: true };
}

// Toggle the notify flag on a saved search without deleting it.
// Bidder can mute/unmute push alerts at any time.
export async function toggleSavedSearchNotify(id: string, notify: boolean): Promise<Result> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'invalid_id' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { error } = await supabase
    .from('saved_searches')
    .update({ notify, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('bidder_id', user.id); // belt-and-braces; RLS also enforces this

  if (error) return { ok: false, error: error.message };

  revalidatePath('/profile/saved-searches');
  return { ok: true };
}
