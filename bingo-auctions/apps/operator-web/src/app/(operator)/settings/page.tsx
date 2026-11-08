// Operator settings — business info, fee config, branding.
//
// Admin-only edits; managers see a read-only view. (Pickers don't see the
// web console at all.)

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { memberProSchemaReady } from '@/lib/member-pro-schema';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { SettingsForm } from './SettingsForm';
import { AutoRelistForm } from './AutoRelistForm';

export default async function SettingsPage() {
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
    .select(
      'id, slug, business_name, legal_name, contact_email, contact_phone, logo_url, brand_color, default_buyer_premium_bps, default_soft_close_minutes, bid_increment_schedule, auto_relist_max_attempts, auto_relist_mode',
    )
    .eq('id', me.operator_id as string)
    .single();
  if (!op) redirect('/onboarding');

  const memberProReady = await memberProSchemaReady(supabase);

  return (
    <div>
      <PageHeader
        title="Settings"
        action={
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Link
              href="/settings/policies"
              style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
            >
              Policies →
            </Link>
            <Link
              href="/settings/fulfillment"
              style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
            >
              Fulfillment →
            </Link>
            <Link
              href="/settings/bidder-experience"
              style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
            >
              Bidder experience →
            </Link>
            <Link
              href="/settings/stripe-tax"
              style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
            >
              Sales tax →
            </Link>
            {memberProReady && (
              <Link
                href="/settings/member-pro"
                style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
              >
                Member Pro →
              </Link>
            )}
          </div>
        }
      />
      <SettingsForm
        canEdit={me.role === 'admin'}
        operator={op as {
          id: string;
          slug: string;
          business_name: string;
          legal_name: string | null;
          contact_email: string;
          contact_phone: string | null;
          logo_url: string | null;
          brand_color: string | null;
          default_buyer_premium_bps: number;
          default_soft_close_minutes: number;
          bid_increment_schedule: import('@auction-platform/shared').BidIncrementTier[] | null;
        }}
      />

      <AutoRelistForm
        canEdit={me.role === 'admin'}
        initialMaxAttempts={(op as { auto_relist_max_attempts: number | null }).auto_relist_max_attempts ?? 2}
        initialMode={
          ((op as { auto_relist_mode: 'auto' | 'review' | 'off' | null }).auto_relist_mode ??
            'review') as 'auto' | 'review' | 'off'
        }
      />
    </div>
  );
}
