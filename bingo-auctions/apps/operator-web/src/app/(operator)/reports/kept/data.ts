// Shared loader for the Kept items report page and its CSV export, so both
// gate and read exactly the same way.
//
// Admin/manager only. lot_internal_keeps RLS already limits reads to the
// operator's admin and manager (mig 0381); the role check here is so other
// staff get a plain "admins or managers only" instead of an empty report.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { KeptRow } from '@/lib/keep-for-business';

export type KeptReport =
  | { ok: false; status: 'no_user' | 'no_operator' | 'forbidden' }
  | { ok: false; status: 'error'; message: string }
  | {
      ok: true;
      operatorId: string;
      rows: KeptRow[];
      // kept_by user id → staff display name or email.
      staffNames: Map<string, string>;
    };

export async function loadKeptReport(supabase: SupabaseClient): Promise<KeptReport> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 'no_user' };

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, status: 'no_operator' };
  const { operator_id: operatorId, role } = me as { operator_id: string; role: string };
  if (role !== 'admin' && role !== 'manager') return { ok: false, status: 'forbidden' };

  const { data, error } = await supabase
    .from('lot_internal_keeps')
    .select('lot_id, lot_code, title, kept_price_cents, reason, kept_by, kept_at, prior_status')
    .eq('operator_id', operatorId)
    .order('kept_at', { ascending: false })
    .limit(5000);
  if (error) return { ok: false, status: 'error', message: error.message };
  const rows = (data ?? []) as KeptRow[];

  // Same actor resolution as the lot page's status timeline.
  const staffNames = new Map<string, string>();
  const ids = [...new Set(rows.map((r) => r.kept_by))];
  if (ids.length > 0) {
    const { data: staff } = await supabase
      .from('operator_users')
      .select('user_id, display_name, email')
      .in('user_id', ids);
    for (const s of staff ?? []) {
      const row = s as { user_id: string; display_name: string | null; email: string };
      staffNames.set(row.user_id, row.display_name ?? row.email);
    }
  }

  return { ok: true, operatorId, rows, staffNames };
}
