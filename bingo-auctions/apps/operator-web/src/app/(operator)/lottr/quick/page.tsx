// Quick Lot — no-manifest, no-AI, ~5-second-per-lot rapid entry.
//
// Server component: auth + role check, category prefetch, render shell.
// All rapid-entry state lives in the QuickLot client component.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { listLeafCategories } from './actions';
import { QuickLot } from './QuickLot';

export default async function QuickLotPage() {
  const supabase = await getSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();

  if (!staff) redirect('/login');
  if (staff.role !== 'admin' && staff.role !== 'manager') {
    // Pickers cannot create lots — show a clear message rather than a 404.
    return (
      <div>
        <PageHeader title="Quick Lot" />
        <p style={{ color: 'var(--danger)', marginTop: '1rem' }}>
          You need admin or manager role to create lots via Quick Lot.
        </p>
      </div>
    );
  }

  const categories = await listLeafCategories();

  return (
    <div>
      <PageHeader
        title="Quick Lot"
        action={
          <Link
            href="/lottr"
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            Back to AI Lotting
          </Link>
        }
      />

      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5, marginBottom: '1.5rem' }}>
        No AI, no price lookup, no manifest required. Type a title, tap a
        condition+price preset, and the lot lands in{' '}
        <strong>pending_intake</strong> ready for a picker to scan to a bin.
        Target: 5 seconds per lot. Use for commodity pallets and identical
        sealed units.
      </p>

      <QuickLot
        categories={categories}
        operatorId={staff.operator_id as string}
      />
    </div>
  );
}
