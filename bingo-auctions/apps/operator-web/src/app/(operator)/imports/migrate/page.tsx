// Server component shell for the legacy-migration import wizard.
// Loads the operator's warehouses (optional intake destination) and
// gate-checks admin/manager role — migration is destructive (preserves
// external lot codes verbatim) so we restrict it to privileged staff.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { MigrateWizard } from './MigrateWizard';

export default async function MigratePage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  if (me.role !== 'admin' && me.role !== 'manager') {
    return (
      <div>
        <PageHeader title="Migrate legacy inventory" />
        <p style={{ color: 'var(--fg-muted)' }}>Admins or managers only.</p>
      </div>
    );
  }

  const operatorId = me.operator_id as string;

  const { data: warehouses } = await supabase
    .from('warehouses')
    .select('id, name')
    .eq('operator_id', operatorId)
    .order('name');

  return (
    <div>
      <PageHeader
        title="Migrate legacy inventory"
        action={
          <Link href="/imports" className="btn-secondary">
            ← Back to imports
          </Link>
        }
      />
      <p
        style={{
          fontSize: 14,
          color: 'var(--fg-muted)',
          marginBottom: '1.5rem',
          maxWidth: 680,
          lineHeight: 1.6,
        }}
      >
        Use this wizard when joining the platform with inventory that already has physical lot codes
        from a prior system. Lot codes are preserved verbatim so staff can scan existing labels.
        Lots land as <strong style={{ color: 'var(--fg)' }}>pending intake</strong>; workers run
        put-away scans to assign bins and flip them to{' '}
        <strong style={{ color: 'var(--fg)' }}>in inventory</strong>.
      </p>
      <MigrateWizard
        warehouses={(warehouses ?? []) as Array<{ id: string; name: string }>}
      />
    </div>
  );
}
