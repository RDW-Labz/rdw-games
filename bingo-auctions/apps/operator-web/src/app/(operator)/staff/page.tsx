// Staff management. Admin-only invite + role change + removal.
//
// Other roles (manager / picker) can see this page but only as read-only —
// the StaffActions client component hides edit/remove controls when not admin.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { StaffList } from './StaffList';

export default async function StaffPage() {
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

  const { data: staff } = await supabase
    .from('operator_users')
    .select('id, email, display_name, role, accepted_at, invited_at, user_id')
    .order('invited_at', { ascending: false });

  return (
    <div>
      <PageHeader title="Staff" />
      {/* Warehouse workers (PIN login) are managed separately — they're
          login-less people who clock in on shared phones, not web-console
          operator_users. */}
      <div style={{ marginBottom: '1rem' }}>
        <a href="/staff/workers" style={{ color: 'var(--accent)', fontWeight: 500 }}>
          Manage warehouse workers (PIN login) →
        </a>
      </div>
      <StaffList
        currentUserId={user.id}
        isAdmin={me?.role === 'admin'}
        staff={
          (staff ?? []) as Array<{
            id: string;
            email: string;
            display_name: string | null;
            role: 'admin' | 'manager' | 'picker' | 'lead';
            accepted_at: string | null;
            invited_at: string;
            user_id: string;
          }>
        }
      />
    </div>
  );
}
