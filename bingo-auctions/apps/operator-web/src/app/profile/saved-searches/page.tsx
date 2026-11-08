// /profile/saved-searches — bidder saved-search management on web.
//
// Parity target: apps/bidder-app/app/profile/saved-searches.tsx (S14, Cluster D2).
//
// Data source: saved_searches WHERE bidder_id = auth.uid()
// ORDER BY created_at DESC.
//
// RLS: saved_searches_self_all (mig 0019:49-52) — FOR ALL using
// bidder_id = auth.uid(). Covers SELECT, UPDATE, DELETE for mutations in
// server actions.
//
// Table columns used (confirmed in mig 0019):
//   id, bidder_id, name, criteria (JSONB), notify (BOOLEAN),
//   last_matched_at (TIMESTAMPTZ), created_at, updated_at.
//
// This page is also the target of the email-drain.ts:228 "mute from your
// profile" link — that sentence points here to let bidders silence a
// saved search without deleting it.
//
// Auth: /profile* gated by middleware. Server component re-checks.
// Nav note: profile/page.tsx is off-limits (in-flight branch). NavCard
// will be added in a follow-up.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { SavedSearchList, type SavedSearchRow } from './SavedSearchList';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function SavedSearchesPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/profile/saved-searches');
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (!bidderRow) {
    redirect('/bidder/onboarding?next=/profile/saved-searches');
  }

  // RLS policy saved_searches_self_all (mig 0019) auto-restricts to the
  // caller's own rows. Belt-and-braces explicit filter also hits the
  // saved_searches_bidder_idx (bidder_id, created_at DESC).
  const { data: rows, error } = await supabase
    .from('saved_searches')
    .select('id, name, criteria, notify, last_matched_at, created_at')
    .eq('bidder_id', user.id)
    .order('created_at', { ascending: false });

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '2rem 1rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <Link
          href="/profile"
          style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}
        >
          ← Profile
        </Link>
        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 800,
            color: 'var(--fg)',
            margin: '0.5rem 0 0.25rem',
          }}
        >
          Saved searches
        </h1>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: 0 }}>
          Get alerted when new lots match. Toggle the switch to mute without deleting.
        </p>
      </div>

      {error && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: 'rgba(255, 59, 59, 0.1)',
            border: '1px solid var(--danger)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 14,
            marginBottom: '1rem',
          }}
        >
          Could not load saved searches: {error.message}
        </div>
      )}

      {!error && (
        <SavedSearchList initialItems={(rows ?? []) as unknown as SavedSearchRow[]} />
      )}
    </div>
  );
}
