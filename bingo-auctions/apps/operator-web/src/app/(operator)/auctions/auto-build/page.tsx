// Auto-build batches of auctions from in-inventory lots. Operator picks
// source filter + batching + schedule, sees a preview, then commits.
//
// Per operator preference: lot ordering is random, even-split across
// generated auctions, fixed cook time + staggered start (Mon→Fri default).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { listWarehousesAndCategories } from './actions';
import { AutoBuildForm } from './AutoBuildForm';

export default async function AutoBuildPage() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await supabase
    .from('operator_users')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!me) redirect('/onboarding');
  if (me.role !== 'admin' && me.role !== 'manager') {
    return (
      <div>
        <PageHeader title="Auto-build auctions" />
        <p>Admins or managers only.</p>
      </div>
    );
  }

  const { warehouses, categories } = await listWarehousesAndCategories();

  return (
    <div>
      <PageHeader
        title="Auto-build auctions"
        action={
          <Link
            href="/auctions"
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            ← Auctions
          </Link>
        }
      />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5 }}>
        Batch-create draft auctions from in-inventory lots. Pick source
        filter + lot count per auction + start cadence — the system
        randomly distributes lots, computes per-auction times, and
        creates everything as <strong>draft</strong>. Review each before
        scheduling.
      </p>
      <AutoBuildForm warehouses={warehouses} categories={categories} />
    </div>
  );
}
