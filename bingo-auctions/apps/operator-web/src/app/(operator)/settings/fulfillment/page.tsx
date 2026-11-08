// Operator fulfillment settings — pickup/shipping toggles + return
// address + default package dimensions + handling fee.
//
// Admin-only. Managers see a read-only view. Loaded server-side so we
// can pre-populate the form with current values.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { FulfillmentForm } from './FulfillmentForm';

export default async function FulfillmentSettingsPage() {
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
    .select('id, business_name, offers_pickup, offers_shipping')
    .eq('id', (me as { operator_id: string }).operator_id)
    .single();
  if (!op) redirect('/onboarding');

  const { data: cfg } = await supabase
    .from('operator_shipping_config')
    .select(
      'return_address, default_pkg_weight_oz, default_pkg_length_in, default_pkg_width_in, default_pkg_height_in, handling_fee_cents',
    )
    .eq('operator_id', (me as { operator_id: string }).operator_id)
    .maybeSingle();

  return (
    <div>
      <PageHeader
        title="Fulfillment"
        action={
          <Link href="/settings" style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>
            ← Settings
          </Link>
        }
      />
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: -8, marginBottom: '1.5rem' }}>
        Choose how this operator delivers items to bidders. You must offer at least one method.
        Switching methods does not affect invoices already paid.
      </p>
      <FulfillmentForm
        canEdit={(me as { role: string }).role === 'admin'}
        operator={{
          id: op.id as string,
          businessName: op.business_name as string,
          offersPickup: (op.offers_pickup as boolean | null) ?? true,
          offersShipping: (op.offers_shipping as boolean | null) ?? false,
        }}
        config={
          cfg
            ? {
                returnAddress: cfg.return_address as {
                  name?: string;
                  company?: string;
                  street1: string;
                  street2?: string;
                  city: string;
                  state: string;
                  zip: string;
                  country?: string;
                  phone?: string;
                } | null,
                defaultPkgWeightOz: cfg.default_pkg_weight_oz as number,
                defaultPkgLengthIn: Number(cfg.default_pkg_length_in),
                defaultPkgWidthIn: Number(cfg.default_pkg_width_in),
                defaultPkgHeightIn: Number(cfg.default_pkg_height_in),
                handlingFeeCents: cfg.handling_fee_cents as number,
              }
            : null
        }
      />
    </div>
  );
}
