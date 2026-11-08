// Operator settings → /settings/policies
//
// Edits the per-operator storefront-display policy fields (buyer's premium,
// pickup hours, dispute window, custom terms, sales-tax opt-in). Distinct
// from /account/policies which manages the legal operator_policies record
// bidders accept before placing their first bid.
//
// Admin-only edits. Managers see a read-only view.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { PoliciesForm } from './PoliciesForm';
import { TaxDocuments, type TaxDocView } from './TaxDocuments';

export const dynamic = 'force-dynamic';

type OperatorRow = {
  id: string;
  default_buyer_premium_bps: number;
  pickup_hours_text: string | null;
  dispute_window_days: number;
  custom_terms_md: string | null;
  collect_sales_tax: boolean;
  tax_mode: 'self_managed' | 'stripe_tax';
  no_show_forfeit_threshold: number;
  forfeit_cooldown_days: number;
};

export default async function OperatorPoliciesPage() {
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
  const meTyped = me as { operator_id: string; role: string };

  const { data: op } = await supabase
    .from('operators')
    .select(
      'id, default_buyer_premium_bps, pickup_hours_text, dispute_window_days, custom_terms_md, collect_sales_tax, tax_mode, no_show_forfeit_threshold, forfeit_cooldown_days',
    )
    .eq('id', meTyped.operator_id)
    .single();
  if (!op) redirect('/onboarding');

  const opRow = op as unknown as OperatorRow;

  // Active tax documents + short-lived signed download URLs (private bucket).
  const { data: docRows } = await supabase
    .from('operator_tax_documents')
    .select('id, file_name, doc_type, state, created_at, storage_path')
    .eq('operator_id', meTyped.operator_id)
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  const taxDocs: TaxDocView[] = [];
  for (const row of (docRows ?? []) as Array<{
    id: string;
    file_name: string;
    doc_type: TaxDocView['doc_type'];
    state: string | null;
    created_at: string;
    storage_path: string;
  }>) {
    const { data: signed } = await supabase.storage
      .from('operator-tax-docs')
      .createSignedUrl(row.storage_path, 3600);
    taxDocs.push({
      id: row.id,
      file_name: row.file_name,
      doc_type: row.doc_type,
      state: row.state,
      created_at: row.created_at,
      url: signed?.signedUrl ?? null,
    });
  }

  return (
    <div>
      <PageHeader
        title="Policies"
        action={
          <Link href="/settings" style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>
            ← Settings
          </Link>
        }
      />
      <p
        style={{
          color: 'var(--fg-muted)',
          fontSize: 13,
          marginTop: -8,
          marginBottom: '1.5rem',
          maxWidth: 720,
        }}
      >
        These show on every auction and lot page so bidders know your buyer&rsquo;s premium,
        when to pick up, how long they have to dispute, and any operator-specific terms.
        Saving updates take effect immediately on the public storefront.
      </p>
      <PoliciesForm
        canEdit={meTyped.role === 'admin'}
        initial={{
          buyerPremiumPct: Math.round(opRow.default_buyer_premium_bps / 100),
          pickupHoursText: opRow.pickup_hours_text ?? '',
          disputeWindowDays: opRow.dispute_window_days,
          customTermsMd: opRow.custom_terms_md ?? '',
          collectSalesTax: opRow.collect_sales_tax,
          taxMode: opRow.tax_mode,
          noShowForfeitThreshold: opRow.no_show_forfeit_threshold,
          forfeitCooldownDays: opRow.forfeit_cooldown_days,
        }}
      />
      <TaxDocuments
        operatorId={meTyped.operator_id}
        canUpload={meTyped.role === 'admin' || meTyped.role === 'manager'}
        canArchive={meTyped.role === 'admin'}
        docs={taxDocs}
      />
    </div>
  );
}
