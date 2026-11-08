// Warehouse workers (PIN login) — manager UI (#2 phase 3).
//
// Distinct from Staff (operator_users, email/web console access). Workers are
// login-less warehouse people who clock in on shared phones with a name + PIN.
// Manager/admin only; reads via the SECURITY DEFINER list_workers_admin RPC so
// pin_hash never reaches the client.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { WorkersManager } from './WorkersManager';

type WorkerRow = {
  id: string;
  display_name: string;
  role: 'admin' | 'manager' | 'picker' | 'lead';
  is_active: boolean;
  locked_until: string | null;
  created_at: string;
  warehouse_id: string | null;
  warehouse_name: string | null;
};

export default async function WorkersPage() {
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
  const role = (me as { role?: string } | null)?.role;
  const operatorId = (me as { operator_id?: string } | null)?.operator_id;
  const isManager = role === 'admin' || role === 'manager';

  let workers: WorkerRow[] = [];
  let warehouses: Array<{ id: string; name: string }> = [];
  if (isManager && operatorId) {
    const [{ data }, { data: whRows }] = await Promise.all([
      supabase.rpc('list_workers_admin', { p_operator_id: operatorId }),
      supabase
        .from('warehouses')
        .select('id, name')
        .eq('operator_id', operatorId)
        .order('name', { ascending: true }),
    ]);
    workers = (data ?? []) as WorkerRow[];
    warehouses = (whRows ?? []) as Array<{ id: string; name: string }>;
  }

  return (
    <div>
      <PageHeader title="Warehouse workers (PIN login)" />
      {isManager ? (
        <WorkersManager workers={workers} warehouses={warehouses} />
      ) : (
        <p style={{ color: 'var(--fg-muted)' }}>
          Only managers can manage warehouse workers.
        </p>
      )}
    </div>
  );
}
