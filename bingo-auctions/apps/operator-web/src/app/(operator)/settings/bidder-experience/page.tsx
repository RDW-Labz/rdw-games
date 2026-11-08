// Bidder experience settings — per-operator feature flag editor.
//
// Lets the operator decide which search/sort/filter conveniences their
// bidders see, and which are gated behind their per-org Pro tier.
// Admin-only edit. Managers see the form read-only.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import type { BidderFeatures } from '@auction-platform/shared/features';
import { BidderFeaturesForm } from './BidderFeaturesForm';

export default async function BidderExperiencePage() {
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

  const { data: op } = await supabase
    .from('operators')
    .select('id, business_name, bidder_features')
    .eq('id', me.operator_id as string)
    .single();
  if (!op) redirect('/onboarding');

  return (
    <div>
      <PageHeader title="Bidder experience" />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5 }}>
        Choose which search, sort, and discovery features your bidders see in the app.
        Set a feature to <strong>Pro</strong> to gate it behind your per-organization
        bidder subscription, <strong>All</strong> to give every bidder access, or
        <strong> Off</strong> to hide it entirely.
      </p>
      <BidderFeaturesForm
        canEdit={me.role === 'admin'}
        initial={(op.bidder_features ?? {}) as BidderFeatures}
      />
    </div>
  );
}
