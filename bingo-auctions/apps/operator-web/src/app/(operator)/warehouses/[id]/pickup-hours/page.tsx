// Pickup-hours editor — weekly grid for warehouse.pickup_hours JSONB,
// slot length, and slot capacity. Also shows a preview of the next day's
// generated slots by calling get_pickup_slots indirectly via a test invoice.

import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { PickupHoursForm } from './PickupHoursForm';
import type { PickupHours } from './actions';
import { WarehouseFormPageV2 } from '../v2/WarehouseFormPageV2';
import { PickupHoursSlotPreviewV2 } from '../v2/PickupHoursSlotPreviewV2';

export default async function PickupHoursPage({
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
        <WarehouseFormPageV2 title="Pickup hours" backHref={`/warehouses/${id}`} backLabel="← Setup">
          <p style={{ color: 'var(--fg-muted)' }}>Admin or manager access required.</p>
        </WarehouseFormPageV2>
      );
    }
    return (
      <div>
        <PageHeader title="Pickup hours" />
        <p style={{ color: 'var(--fg-muted)' }}>Admin or manager access required.</p>
      </div>
    );
  }

  const { data: warehouse } = await supabase
    .from('warehouses')
    .select('id, name, timezone, pickup_hours, pickup_slot_minutes, pickup_slot_capacity, operator_id')
    .eq('id', id)
    .single();

  if (!warehouse) notFound();
  if ((warehouse as { operator_id: string }).operator_id !== (me as { operator_id: string }).operator_id) {
    notFound();
  }

  const initialHours = ((warehouse.pickup_hours ?? {}) as PickupHours);
  const slotMinutes = (warehouse.pickup_slot_minutes as number | null) ?? 30;
  const slotCapacity = (warehouse.pickup_slot_capacity as number | null) ?? 5;

  // Build a human-readable preview of the current schedule for the next 7 days.
  // get_pickup_slots() requires an invoice_id we can't easily manufacture here,
  // so we reconstruct the logic in JS from the saved pickup_hours for display.
  //
  // 2026-05-20 BUG-007 fix: the previous day-of-week calc round-tripped through
  // `new Date(date.toLocaleDateString(..., { timeZone: tz })).getDay()` which
  // strips the timezone, then re-parses the locale-date-string as the SERVER's
  // local time (UTC on Cloudflare Workers). For non-UTC warehouses around UTC
  // midnight that produced the wrong day's hours. Fix: use Intl.DateTimeFormat
  // with `weekday: 'short'` directly + a lookup, so the tz is honored end-to-end.
  const DAY_FROM_WEEKDAY: Record<string, string> = {
    Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat',
  };
  const now = new Date();
  const tz = (warehouse.timezone as string | null) ?? 'America/New_York';
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });

  const previewDays: { label: string; slots: string[] }[] = [];
  for (let d = 0; d < 7; d++) {
    const date = new Date(now.getTime() + d * 86_400_000);
    const localDateStr = date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
    const weekdayShort = weekdayFmt.format(date); // 'Sun', 'Mon', …
    const dayKey = DAY_FROM_WEEKDAY[weekdayShort] ?? 'mon';
    const windows = (initialHours[dayKey] ?? []);
    const slots: string[] = [];
    for (const w of windows) {
      const [oh, om] = w.open.split(':').map((s) => Number(s));
      const [ch, cm] = w.close.split(':').map((s) => Number(s));
      let cursor = (oh ?? 0) * 60 + (om ?? 0);
      const closeMin = (ch ?? 0) * 60 + (cm ?? 0);
      while (cursor < closeMin) {
        const hh = String(Math.floor(cursor / 60)).padStart(2, '0');
        const mm = String(cursor % 60).padStart(2, '0');
        slots.push(`${hh}:${mm}`);
        cursor += slotMinutes;
      }
    }
    previewDays.push({ label: localDateStr, slots });
  }

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    return (
      <WarehouseFormPageV2
        title={`${warehouse.name as string} — Pickup hours`}
        backHref={`/warehouses/${id}`}
        backLabel="← Setup"
      >
        <PickupHoursForm
          warehouseId={id}
          initialHours={initialHours}
          initialSlotMinutes={slotMinutes}
          initialSlotCapacity={slotCapacity}
        />
        <PickupHoursSlotPreviewV2 tz={tz} previewDays={previewDays} />
      </WarehouseFormPageV2>
    );
  }

  return (
    <div>
      <PageHeader
        title={`${warehouse.name as string} — Pickup hours`}
        action={
          <Link
            href={`/warehouses/${id}`}
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            ← Setup
          </Link>
        }
      />

      <PickupHoursForm
        warehouseId={id}
        initialHours={initialHours}
        initialSlotMinutes={slotMinutes}
        initialSlotCapacity={slotCapacity}
      />

      {/* Slot preview */}
      <section
        style={{
          marginTop: '2rem',
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
        }}
      >
        <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.75rem' }}>
          Slot preview — next 7 days ({tz})
        </h2>
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 1rem' }}>
          Reflects the currently saved schedule, not unsaved changes.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.75rem' }}>
          {previewDays.map(({ label, slots }) => (
            <div key={label}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: '0.4rem' }}>{label}</div>
              {slots.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Closed</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                  {slots.slice(0, 12).map((s) => (
                    <span
                      key={s}
                      style={{
                        fontSize: 11,
                        padding: '0.1rem 0.35rem',
                        background: 'var(--bg)',
                        border: '1px solid var(--border)',
                        borderRadius: 3,
                      }}
                    >
                      {s}
                    </span>
                  ))}
                  {slots.length > 12 && (
                    <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>+{slots.length - 12} more</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
