import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { isWarehouseActive } from '@/lib/warehouse-active';
import { CustomerInfoForm } from './CustomerInfoForm';
import { WarehouseFormPageV2 } from '../v2/WarehouseFormPageV2';

export default async function CustomerInfoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  if (!['admin', 'manager'].includes((me as { role: string }).role)) {
    const cookieStoreDenied = await cookies();
    if (isConsoleV2(cookieStoreDenied.get(CONSOLE_UI_COOKIE)?.value)) {
      return (
        <WarehouseFormPageV2 title="Customer info" backHref={`/warehouses/${id}`} backLabel="← Setup">
          <p style={{ color: 'var(--fg-muted)' }}>Admin or manager access required.</p>
        </WarehouseFormPageV2>
      );
    }
    return (
      <div>
        <PageHeader title="Customer info" />
        <p style={{ color: 'var(--fg-muted)' }}>Admin or manager access required.</p>
      </div>
    );
  }

  const { data: warehouse } = await supabase
    .from('warehouses')
    .select('id, name, operator_id, pickup_instructions, customer_notice, active')
    .eq('id', id)
    .single();

  if (!warehouse) notFound();
  if ((warehouse as { operator_id: string }).operator_id !== (me as { operator_id: string }).operator_id) {
    notFound();
  }

  const row = warehouse as {
    name: string;
    pickup_instructions: string | null;
    customer_notice: string | null;
    active: boolean;
  };

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    return (
      <WarehouseFormPageV2
        title={`${row.name} — Customer info`}
        backHref={`/warehouses/${id}`}
        backLabel="← Setup"
      >
        <CustomerInfoForm
          warehouseId={id}
          initialPickupInstructions={row.pickup_instructions ?? ''}
          initialCustomerNotice={row.customer_notice ?? ''}
          initialActive={isWarehouseActive(row)}
        />
      </WarehouseFormPageV2>
    );
  }

  return (
    <div>
      <PageHeader
        title={`${row.name} — Customer info`}
        action={
          <Link
            href={`/warehouses/${id}`}
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            ← Setup
          </Link>
        }
      />

      <CustomerInfoForm
        warehouseId={id}
        initialPickupInstructions={row.pickup_instructions ?? ''}
        initialCustomerNotice={row.customer_notice ?? ''}
        initialActive={isWarehouseActive(row)}
      />
    </div>
  );
}
