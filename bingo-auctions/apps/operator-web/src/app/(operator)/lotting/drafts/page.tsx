// /lotting/drafts — field-lotted items with a printed label but no bin yet.
//
// Background:
//   Lotting tools (Quick Lot, AI Photo Scan, and Web Lookup — all on
//   field-mobile or operator-web) mint a real lot in the moment the
//   operator photographs/scans/looks up the item. The lot gets a
//   lot_code and a thermal QR label, but it isn't physically in a bin
//   yet — status='pending_intake'.
//
//   The next step (putaway) is what flips status to 'in_inventory' and
//   lands the lot on the Inventory page. Putaway happens in the
//   field-mobile picker via the QR scan + bin scan flow — that's also
//   where Batch Mode and Shelf Scan live.
//
//   This page surfaces drafts so they aren't forgotten on a staging
//   shelf. Two actions per row:
//     - "Delete draft" (hard delete) — for mistakes / abandoned scans.
//     - Implicit: pick the item up + bin-scan in the picker (Batch
//       Mode / Shelf Scan available there) to move it to Inventory.
//
//   Bulk put-away (assign to a bin from the laptop) was intentionally
//   NOT carried over from the prior Inventory put-away UI — the user
//   should be holding the physical item to confirm a bin location,
//   which means going through the picker app on the phone.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { DraftsTable } from './DraftsTable';

type DraftRow = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  title: string;
  source: string | null;
  msrp_cents: number | null;
  photo_urls: string[] | null;
  created_at: string;
};

export default async function DraftsPage() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const { data: lotsData } = await supabase
    .from('lots')
    .select('id, lot_code, sticker_code, display_code, title, source, msrp_cents, photo_urls, created_at')
    .eq('operator_id', me.operator_id as string)
    .eq('status', 'pending_intake')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(500);
  const lots = (lotsData ?? []) as unknown as DraftRow[];

  return (
    <div>
      <PageHeader
        title="Drafts"
        action={
          lots.length > 0 ? (
            <a
              href="/lotting/drafts/export"
              style={{
                padding: '6px 12px',
                background: 'transparent',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              Export CSV ({lots.length})
            </a>
          ) : undefined
        }
      />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5, marginBottom: 16 }}>
        Field-lotted items with a printed thermal label, waiting to be
        scanned into a bin. Once a picker scans them via the field-mobile
        app they&apos;ll move to{' '}
        <Link href="/lotting/inventory" style={{ color: 'var(--accent)' }}>
          Inventory
        </Link>
        . Manifest-expected items that haven&apos;t arrived live in{' '}
        <Link href="/lotting/manifest-pool" style={{ color: 'var(--accent)' }}>
          Manifest pool
        </Link>
        .
      </p>
      {lots.length === 500 && (
        <div
          style={{
            padding: 12,
            background: 'var(--bg-elev)',
            border: '1px solid var(--warning, #fbbf24)',
            color: 'var(--warning, #fbbf24)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
            maxWidth: 720,
          }}
        >
          Showing the first 500 drafts (most recent). Older drafts may
          exist. Use the CSV export above to see them all.
        </div>
      )}

      {lots.length === 0 ? (
        <div
          style={{
            padding: 32,
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--fg-muted)',
            maxWidth: 720,
          }}
        >
          No drafts. Everything that&apos;s been field-lotted is already in a bin.
        </div>
      ) : (
        <DraftsTable
          canEdit={me.role === 'admin' || me.role === 'manager'}
          lots={lots}
        />
      )}
    </div>
  );
}
