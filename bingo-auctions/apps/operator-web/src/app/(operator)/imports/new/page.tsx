// Server component shell for the import wizard. Loads the operator's
// warehouses so the wizard can offer one as the optional intake
// destination — the manifest doesn't know which warehouse the truck
// will land at, but if the operator does, they can pick now and skip
// having to set it during intake scanning later. Auctions are NOT
// loaded here: imports go to inventory (pending_intake), and the
// auction-builder is what later pulls inventory into an auction.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { ImportWizard } from './ImportWizard';

export default async function NewImportPage() {
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
        <PageHeader title="Import manifest" />
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

  // Pull every distinct source_label this operator has used before so the
  // wizard can offer them as a quick-pick / autocomplete. Reported during
  // dogfooding: "import does not have a source/truckload to map to" — the
  // operator wanted to reuse "Test1" without remembering exact spelling.
  // The label IS a free-text field, but discoverability was poor.
  const { data: sourceRows } = await supabase
    .from('imports')
    .select('source_label')
    .eq('operator_id', operatorId)
    .not('source_label', 'is', null)
    .order('created_at', { ascending: false })
    .limit(200);
  const recentSources = Array.from(
    new Set(
      (sourceRows ?? [])
        .map((r) => (r as { source_label: string | null }).source_label?.trim())
        .filter((v): v is string => Boolean(v && v.length > 0)),
    ),
  ).slice(0, 25);

  return (
    <div>
      <PageHeader
        title="Import manifest"
        action={
          <Link href="/imports" className="btn-secondary">
            ← Back to imports
          </Link>
        }
      />
      <ImportWizard
        warehouses={(warehouses ?? []) as Array<{ id: string; name: string }>}
        recentSources={recentSources}
      />
    </div>
  );
}
