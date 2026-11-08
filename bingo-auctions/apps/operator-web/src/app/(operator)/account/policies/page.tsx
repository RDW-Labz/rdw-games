// /account/policies — operator's per-bidder policy documents.
//
// Each operator on BinGo Auctions publishes their own Terms of Service, Refund
// Policy, and Shipping Policy. These are presented to bidders the first
// time they place a bid with an operator they haven't bid with before
// (and re-presented when the operator publishes a new version).
//
// This is the editor surface. Three markdown bodies + four operational
// fields (payment_window_hours, pickup_window_days, shipping_offered,
// refund_window_post_pickup_hours). The page shows the active published
// version and the latest draft (if any), so an admin can see "what's
// live" vs "what I'm working on" at a glance.
//
// Why /account vs /settings: this lives in the operator's account/admin
// subtree because (a) it requires admin role to write, (b) it's
// middleware-gated to AAL2, and (c) it shares the same access posture as
// the MFA + payouts pages already living under /account. Bidder-facing
// reads happen elsewhere — bidders never come through this page.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { PoliciesForm } from './PoliciesForm';

export const dynamic = 'force-dynamic';

type PolicyRow = {
  operator_id: string;
  version: number;
  terms_md: string;
  refund_md: string;
  shipping_md: string;
  payment_window_hours: number; // deprecated 2026-05-29 — display-only
  pickup_window_days: number;
  refund_window_post_pickup_hours: number;
  // PR-A1 additions (2026-05-29):
  no_show_policy: 'full_forfeit' | 'refund_minus_restock';
  restock_fee_cents: number;
  relist_fee_cents: number;
  admin_can_refund_outside_window: boolean;
  // CHK-01 / CHK-02 (checkout improvements, mig 0193):
  require_identity_check: boolean;
  identity_check_threshold_cents: number;
  require_signature: boolean;
  effective_at: string;
  published: boolean;
  content_hash: string;
  created_at: string;
};

export default async function PoliciesPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Resolve the caller's operator + role. Only admins can edit, but staff
  // can view (read RLS already permits this via operator_users membership).
  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!staff) redirect('/onboarding');

  const operatorId = (staff as { operator_id: string }).operator_id;
  const role = (staff as { role: string }).role;
  const isAdmin = role === 'admin';

  // Pull every version this operator has authored, newest first. Most
  // operators will have ≤ 5 rows so we don't paginate — Supabase's default
  // 1000-row cap is fine. Sorting in JS keeps the page-shape simple.
  const { data: rows } = await supabase
    .from('operator_policies')
    .select(
      'operator_id, version, terms_md, refund_md, shipping_md, ' +
        'payment_window_hours, pickup_window_days, ' +
        'refund_window_post_pickup_hours, ' +
        // PR-A1 additions (2026-05-29):
        'no_show_policy, restock_fee_cents, relist_fee_cents, ' +
        'admin_can_refund_outside_window, ' +
        // CHK-01 / CHK-02 additions (mig 0193):
        'require_identity_check, identity_check_threshold_cents, require_signature, ' +
        'effective_at, published, content_hash, created_at',
    )
    .eq('operator_id', operatorId)
    .order('version', { ascending: false });

  // Cast via unknown — Supabase's typed client returns the column list as
  // a union including `GenericStringError` (the JOIN error type); we know
  // our query is flat so the cast is safe.
  const policies = ((rows ?? []) as unknown) as PolicyRow[];

  // Active = latest version with published=true. There's an index on
  // (operator_id, published, effective_at DESC) so this is also what the
  // public RPC returns to bidders.
  const active = policies.find((p) => p.published) ?? null;
  // Latest = absolute newest row regardless of published. If the latest
  // is also active, draft = null and we just show "active is current."
  const latest = policies[0] ?? null;
  const draft = latest && !latest.published ? latest : null;

  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Bidder policies" />

      <p
        style={{
          color: 'var(--fg-muted)',
          marginBottom: '1.5rem',
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        Bidders see these terms the first time they bid in one of your
        auctions, and again whenever you publish a new version. They&apos;re
        layered on top of the{' '}
        <Link href="/legal/terms">BinGo Auctions platform Terms of Service</Link> and{' '}
        <Link href="/legal/bidder-agreement">Bidder Agreement</Link> — you don&apos;t
        need to restate the platform rules, just the parts unique to your
        operation (payment window, pickup, refunds, shipping).
      </p>

      {!isAdmin && (
        <div
          style={{
            padding: '0.85rem 1rem',
            background: 'rgba(255, 165, 0, 0.06)',
            border: '1px solid rgba(255, 165, 0, 0.3)',
            borderRadius: 8,
            marginBottom: '1.25rem',
            fontSize: 13,
            color: 'var(--fg-muted)',
          }}
        >
          Read-only view. Only operator admins can edit or publish policies.
        </div>
      )}

      <PoliciesForm
        operatorId={operatorId}
        isAdmin={isAdmin}
        active={active}
        draft={draft}
      />
    </div>
  );
}
