import Link from 'next/link';
import { cookies } from 'next/headers';
import { getSupabaseServer } from '@/lib/supabase-server';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { isWarehouseOffSite } from '@/components/console-v2/off-site';
import { PageHeader, buttonStyle, secondaryButtonStyle } from '@/components/Form';
import { isWarehouseActive } from '@/lib/warehouse-active';

const PICKUP_MODE_LABEL: Record<string, string> = {
  staff_assisted: 'Staff-assisted',
  counter_pickup: 'Counter pickup',
  self_serve_floor_plan: 'Self-serve (floor plan)',
  hybrid: 'Hybrid',
  // Legacy label — remapped by migration 0165
  self_serve: 'Customer pickup (legacy)',
};
import { WarehousesV2 } from './v2/WarehousesV2';
import type { WarehouseListV2Row } from './v2/warehouse-types';
import { PICKUP_MODE_LABEL as V2_PICKUP_MODE_LABEL } from './v2/warehouse-labels';

export default async function WarehousesPage() {
  const supabase = await getSupabaseServer();
  const { data: warehouses } = await supabase
    .from('warehouses')
    .select('*')
    .order('created_at', { ascending: false });

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    const v2Rows: WarehouseListV2Row[] = (warehouses ?? []).map((w) => {
      const mode = (w as { pickup_mode: string | null }).pickup_mode ?? 'staff_assisted';
      return {
        id: w.id as string,
        name: w.name as string,
        city: w.city as string,
        state: w.state as string,
        inactive: !isWarehouseActive(w as { active?: boolean | null }),
        offSite: isWarehouseOffSite(w as { customer_notice?: string | null }),
        pickupModeLabel: V2_PICKUP_MODE_LABEL[mode] ?? mode,
        hasFloorPlan: Boolean(w.floor_plan_url),
      };
    });
    return <WarehousesV2 rows={v2Rows} />;
  }

  return (
    <div>
      <PageHeader
        title="Warehouses"
        action={
          <Link href="/warehouses/new" style={{ ...buttonStyle, textDecoration: 'none' }}>
            New warehouse
          </Link>
        }
      />
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem' }}>
        {warehouses?.map((w) => {
          const mode = (w as { pickup_mode: string | null }).pickup_mode ?? 'staff_assisted';
          const inactive = !isWarehouseActive(w as { active?: boolean | null });
          return (
            <li
              key={w.id}
              style={{
                padding: '1rem',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '1rem',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {w.name}
                  {inactive && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '0.1rem 0.4rem',
                        borderRadius: 4,
                        background: 'rgba(255,84,112,0.12)',
                        color: 'var(--danger)',
                      }}
                    >
                      Inactive
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)' }}>
                  {w.city}, {w.state} ·{' '}
                  {w.floor_plan_url ? 'floor plan uploaded' : 'no floor plan'} ·{' '}
                  {PICKUP_MODE_LABEL[mode] ?? mode}
                </div>
              </div>
              <Link
                href={`/warehouses/${w.id}`}
                style={{ ...secondaryButtonStyle, textDecoration: 'none', whiteSpace: 'nowrap' }}
              >
                Setup →
              </Link>
            </li>
          );
        })}
        {!warehouses?.length && (
          <li style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
            No warehouses yet. <Link href="/warehouses/new">Add one</Link> to start placing bins.
          </li>
        )}
      </ul>
    </div>
  );
}
