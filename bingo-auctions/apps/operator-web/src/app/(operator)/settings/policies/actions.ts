'use server';

// Server actions for /settings/policies — operator's display-policy
// snippets (buyer's premium, pickup hours, dispute window, custom terms,
// sales-tax opt-in) shown on bidder-facing auction + lot pages.
//
// These are distinct from operator_policies (the legal terms doc that
// bidders explicitly accept). This screen only edits the storefront
// display fields added in migration 0113 plus the existing
// default_buyer_premium_bps on operators.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { operatorCan } from '@/lib/operator-can';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

const policiesSchema = z.object({
  // Buyer's premium as integer 0–30 (UI surface). Stored as basis-points
  // on operators.default_buyer_premium_bps (×100).
  buyerPremiumPct: z.number().int().min(0).max(30),
  pickupHoursText: z.string().max(2000).nullable(),
  disputeWindowDays: z.number().int().min(0).max(30),
  customTermsMd: z.string().max(20000).nullable(),
  collectSalesTax: z.boolean(),
  // Per-operator sales-tax mode (mig 0195). self_managed = operator collects/
  // remits their own tax (default); stripe_tax = platform computes via Stripe
  // Tax (env-gated, pending legal sign-off).
  taxMode: z.enum(['self_managed', 'stripe_tax']),
  // No-show forfeit fields (mig 0144 + mig 0166).
  noShowForfeitThreshold: z.number().int().min(1).max(20),
  forfeitCooldownDays: z.number().int().min(0).max(365),
});

export type PoliciesInput = z.infer<typeof policiesSchema>;
export type SavePoliciesResult = { ok: true } | { ok: false; error: string };

export async function saveOperatorPolicies(input: PoliciesInput): Promise<SavePoliciesResult> {
  const parsed = policiesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, error: 'not_in_operator_users' };
  const meTyped = me as { operator_id: string; role: string };
  if (!(await operatorCan(supabase, 'policy.edit'))) {
    return { ok: false, error: 'Only admins can change operator policies.' };
  }

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('operators')
    .update({
      // Buyer's premium pct (UI) → basis points (DB).
      default_buyer_premium_bps: parsed.data.buyerPremiumPct * 100,
      pickup_hours_text:
        parsed.data.pickupHoursText && parsed.data.pickupHoursText.trim().length > 0
          ? parsed.data.pickupHoursText
          : null,
      dispute_window_days: parsed.data.disputeWindowDays,
      custom_terms_md:
        parsed.data.customTermsMd && parsed.data.customTermsMd.trim().length > 0
          ? parsed.data.customTermsMd
          : null,
      collect_sales_tax: parsed.data.collectSalesTax,
      tax_mode: parsed.data.taxMode,
      no_show_forfeit_threshold: parsed.data.noShowForfeitThreshold,
      forfeit_cooldown_days: parsed.data.forfeitCooldownDays,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', meTyped.operator_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/policies');
  revalidatePath('/settings');
  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────────
// Tax documents (mig 0195). Operators on tax_mode='self_managed' upload their
// own sales-tax permit / registration as a compliance record. The file itself
// is uploaded client-side to the private 'operator-tax-docs' bucket (path
// '<operator_id>/<uuid>.<ext>', storage RLS path-scoped); these actions only
// record / archive the metadata row. RLS (mig 0195) is the real gate; the role
// checks here are defense-in-depth.
// ───────────────────────────────────────────────────────────────────────────

const taxDocSchema = z.object({
  storagePath: z.string().min(1).max(500),
  fileName: z.string().min(1).max(255),
  docType: z.enum(['sales_tax_permit', 'registration', 'resale_exemption', 'other']),
  state: z
    .string()
    .trim()
    .length(2)
    .nullable()
    .optional(),
});

export type RecordTaxDocResult = { ok: true; id: string } | { ok: false; error: string };

export async function recordTaxDocument(
  input: z.infer<typeof taxDocSchema>,
): Promise<RecordTaxDocResult> {
  const parsed = taxDocSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, error: 'not_in_operator_users' };
  const meTyped = me as { operator_id: string; role: string };
  if (meTyped.role !== 'admin' && meTyped.role !== 'manager') {
    return { ok: false, error: 'Only admins or managers can upload tax documents.' };
  }

  // The storage object must live under this operator's path prefix (the storage
  // RLS enforces the same); reject anything else so a row can't point at another
  // operator's file.
  if (!parsed.data.storagePath.startsWith(`${meTyped.operator_id}/`)) {
    return { ok: false, error: 'Storage path is not scoped to your operator.' };
  }

  const { data, error } = await supabase
    .from('operator_tax_documents')
    .insert({
      operator_id: meTyped.operator_id,
      storage_path: parsed.data.storagePath,
      file_name: parsed.data.fileName,
      doc_type: parsed.data.docType,
      state: parsed.data.state ?? null,
      uploaded_by: user.id,
    } as never)
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'insert failed' };

  revalidatePath('/settings/policies');
  return { ok: true, id: (data as { id: string }).id };
}

export async function archiveTaxDocument(id: string): Promise<SavePoliciesResult> {
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'Invalid document id' };
  }
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, error: 'not_in_operator_users' };
  const meTyped = me as { operator_id: string; role: string };
  if (meTyped.role !== 'admin') {
    return { ok: false, error: 'Only admins can remove tax documents.' };
  }

  const { error } = await supabase
    .from('operator_tax_documents')
    .update({ archived_at: new Date().toISOString() } as never)
    .eq('id', id)
    .eq('operator_id', meTyped.operator_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/policies');
  return { ok: true };
}
