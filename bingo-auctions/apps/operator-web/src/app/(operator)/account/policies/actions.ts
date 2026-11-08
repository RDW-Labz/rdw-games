// Server actions for /account/policies — save-draft and publish.
//
// Both actions insert a NEW row into operator_policies. We never UPDATE
// in place because acceptances (operator_policy_acceptances) reference
// (operator_id, version) via a foreign key — mutating a published row
// would silently invalidate every prior consent for that version. New
// rows + version bump means consent history stays intact.
//
// Draft → published=false, hidden from the bidder app's
// get_active_operator_policy() RPC. Operators can keep tweaking without
// affecting live bidders. Only one draft row is meaningful at a time —
// re-saving overwrites by version-bumping again.
//
// Publish → published=true. The bidder app starts presenting it on the
// next first-bid event. Anyone who had previously accepted a prior
// version is re-prompted (the modal checks accepted-version vs latest).
//
// content_hash is SHA-256 of (terms_md + refund_md + shipping_md) so
// audit / forensics can verify exactly what text was live at any point
// without re-reading the table. We hash on the server side via Node's
// crypto so the format is identical to the platform-level policy hash.

'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

const inputSchema = z.object({
  terms_md: z.string().min(20).max(50_000),
  refund_md: z.string().min(20).max(50_000),
  shipping_md: z.string().min(20).max(50_000),
  payment_window_hours: z.coerce.number().int().min(0).max(168),
  pickup_window_days: z.coerce.number().int().min(1).max(30),
  refund_window_post_pickup_hours: z.coerce.number().int().min(0).max(720),
  // PR-A1 additions (2026-05-29). The form accepts dollars-with-cents for
  // fees but the column stores cents — coerce float dollars to integer cents
  // before insert.
  // 'refund_minus_restock' removed 2026-09-16 — it promised the bidder a refund
  // (push + "refund pending" copy) and enqueued refund_jobs, but the drain
  // worker was deleted in the Square cutover so nothing ever paid it out. The
  // DB CHECK still allows the value; this narrows only what the form can SET.
  no_show_policy: z.enum(['full_forfeit']),
  restock_fee_dollars: z.coerce.number().min(0).max(10_000),
  relist_fee_dollars: z.coerce.number().min(0).max(10_000),
  admin_can_refund_outside_window: z.coerce.boolean(),
  // CHK-01 / CHK-02 (checkout improvements). The identity threshold is entered
  // in dollars on the form and stored as integer cents (mirrors the fee fields).
  require_identity_check: z.coerce.boolean(),
  identity_check_threshold_dollars: z.coerce.number().min(0).max(1_000_000),
  require_signature: z.coerce.boolean(),
});

export type PolicyActionResult =
  | { ok: true; version: number; published: boolean }
  | { ok: false; error: string };

// Shared core: validate input, resolve admin identity + operator, compute
// next version, insert. Caller picks the published flag. Returns the new
// row's version on success.
async function writePolicyRow(
  formData: FormData,
  published: boolean,
): Promise<PolicyActionResult> {
  // Parse + coerce. checkbox fields arrive as "on" or missing — coerce to
  // boolean by checking presence rather than relying on z.coerce.boolean
  // (which treats the string "false" as truthy).
  const raw = {
    terms_md: formData.get('terms_md'),
    refund_md: formData.get('refund_md'),
    shipping_md: formData.get('shipping_md'),
    payment_window_hours: formData.get('payment_window_hours'),
    pickup_window_days: formData.get('pickup_window_days'),
    refund_window_post_pickup_hours: formData.get(
      'refund_window_post_pickup_hours',
    ),
    // PR-A1: new no-show + refund policy fields.
    no_show_policy: formData.get('no_show_policy'),
    restock_fee_dollars: formData.get('restock_fee_cents'),
    relist_fee_dollars: formData.get('relist_fee_cents'),
    admin_can_refund_outside_window:
      formData.get('admin_can_refund_outside_window') === 'on',
    // CHK-01 / CHK-02 checkout fields. Checkboxes arrive as "on" or missing —
    // coerce by presence (same as admin_can_refund_outside_window above).
    require_identity_check: formData.get('require_identity_check') === 'on',
    identity_check_threshold_dollars: formData.get(
      'identity_check_threshold_dollars',
    ),
    require_signature: formData.get('require_signature') === 'on',
  };
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'invalid_input',
    };
  }

  // Identity check uses the user's own cookie session — service role
  // would bypass our own row-level check. We're not relying ONLY on RLS
  // here: we hand-check the admin role in case some future migration
  // relaxes the operator_policies UPDATE policy.
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { data: staffRow } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  const staff = staffRow as { operator_id: string; role: string } | null;
  if (!staff) return { ok: false, error: 'not_operator_staff' };
  if (staff.role !== 'admin') return { ok: false, error: 'not_admin' };

  // Next version = max(version) + 1. We use the admin (service-role)
  // client for this read to dodge an RLS edge case where a staff member
  // who isn't an admin would only see the most-recent published row —
  // we want the absolute max version regardless of published flag.
  const admin = getSupabaseAdmin();
  const { data: maxRow } = await admin
    .from('operator_policies')
    .select('version')
    .eq('operator_id', staff.operator_id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion =
    ((maxRow as { version?: number } | null)?.version ?? 0) + 1;

  const contentHash = createHash('sha256')
    .update(parsed.data.terms_md)
    .update('\n---\n')
    .update(parsed.data.refund_md)
    .update('\n---\n')
    .update(parsed.data.shipping_md)
    .digest('hex');

  // PR-A1: coerce dollar inputs to cents for storage. Round to nearest cent
  // to avoid floating-point drift when the form posts something like 5.005.
  const restockFeeCents = Math.round(parsed.data.restock_fee_dollars * 100);
  const relistFeeCents = Math.round(parsed.data.relist_fee_dollars * 100);
  // CHK-01: identity-check threshold is entered in dollars, stored in cents.
  const identityCheckThresholdCents = Math.round(
    parsed.data.identity_check_threshold_dollars * 100,
  );

  // INSERT via the admin client to avoid double-tripping RLS (we've
  // already verified the caller is an admin of this operator). This
  // mirrors how /api/staff/* and other admin-only mutations are written
  // elsewhere in the codebase.
  const { error: insertErr } = await admin.from('operator_policies').insert({
    operator_id: staff.operator_id,
    version: nextVersion,
    terms_md: parsed.data.terms_md,
    refund_md: parsed.data.refund_md,
    shipping_md: parsed.data.shipping_md,
    payment_window_hours: parsed.data.payment_window_hours,
    pickup_window_days: parsed.data.pickup_window_days,
    refund_window_post_pickup_hours: parsed.data.refund_window_post_pickup_hours,
    // PR-A1 additions:
    no_show_policy: parsed.data.no_show_policy,
    restock_fee_cents: restockFeeCents,
    relist_fee_cents: relistFeeCents,
    admin_can_refund_outside_window: parsed.data.admin_can_refund_outside_window,
    // CHK-01 / CHK-02 checkout-flow toggles (mig 0193):
    require_identity_check: parsed.data.require_identity_check,
    identity_check_threshold_cents: identityCheckThresholdCents,
    require_signature: parsed.data.require_signature,
    published,
    content_hash: contentHash,
    created_by: user.id,
  });
  if (insertErr) {
    return { ok: false, error: insertErr.message };
  }

  // Single-published-row invariant: when publishing, demote every OTHER
  // published version for this operator so exactly one row has published=true.
  // (Prior bug: publishPolicy inserted a published=true row without clearing
  // the previous published one, leaving multiple published rows. Money-path
  // readers compensated with ORDER BY version DESC, but disputes/page.tsx +
  // the get_active_operator_policy RPC sort by effective_at — so the views
  // could disagree on which policy was active.) Demote AFTER the insert so a
  // failure here leaves the newest correct row published rather than zero.
  if (published) {
    const { error: demoteErr } = await admin
      .from('operator_policies')
      .update({ published: false })
      .eq('operator_id', staff.operator_id)
      .eq('published', true)
      .neq('version', nextVersion);
    if (demoteErr) {
      return { ok: false, error: demoteErr.message };
    }
  }

  // PR-A1: write an audit log entry capturing the edit. Failure to write the
  // audit row should NOT fail the policy change (the policy is the source of
  // truth) — log the error and continue. Future PRs will tighten this if
  // audit-completeness becomes mandatory.
  const { error: auditErr } = await admin.from('operator_audit_log').insert({
    operator_id: staff.operator_id,
    actor_user_id: user.id,
    action_type: 'policy.edit',
    target_id: null,
    before_state: null,
    after_state: {
      version: nextVersion,
      published,
      no_show_policy: parsed.data.no_show_policy,
      restock_fee_cents: restockFeeCents,
      relist_fee_cents: relistFeeCents,
      admin_can_refund_outside_window: parsed.data.admin_can_refund_outside_window,
      pickup_window_days: parsed.data.pickup_window_days,
      refund_window_post_pickup_hours: parsed.data.refund_window_post_pickup_hours,
      // CHK-01 / CHK-02:
      require_identity_check: parsed.data.require_identity_check,
      identity_check_threshold_cents: identityCheckThresholdCents,
      require_signature: parsed.data.require_signature,
    },
    reason_note: published
      ? `Published policy v${nextVersion}`
      : `Saved draft policy v${nextVersion}`,
  });
  if (auditErr) {
    // Don't fail the action — log to server console for ops.
    // eslint-disable-next-line no-console
    console.warn(
      `[policies] audit log write failed for op=${staff.operator_id} v=${nextVersion}:`,
      auditErr.message,
    );
  }

  // Bust the policies page cache so the next render shows the new draft
  // / published row immediately.
  revalidatePath('/account/policies');

  return { ok: true, version: nextVersion, published };
}

export async function saveDraft(formData: FormData): Promise<PolicyActionResult> {
  return writePolicyRow(formData, false);
}

export async function publishPolicy(formData: FormData): Promise<PolicyActionResult> {
  return writePolicyRow(formData, true);
}
