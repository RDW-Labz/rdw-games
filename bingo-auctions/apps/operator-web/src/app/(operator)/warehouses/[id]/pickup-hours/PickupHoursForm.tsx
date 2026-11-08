'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle, inputStyle, Field } from '@/components/Form';
import { savePickupHours, type PickupHours } from './actions';

const DAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
] as const;

type DayKey = (typeof DAYS)[number]['key'];

function buildInitial(existing: PickupHours): Record<DayKey, { enabled: boolean; open: string; close: string }> {
  const result = {} as Record<DayKey, { enabled: boolean; open: string; close: string }>;
  for (const { key } of DAYS) {
    const windows = existing[key] ?? [];
    const first = windows[0];
    result[key] = {
      enabled: windows.length > 0,
      open: first?.open ?? '09:00',
      close: first?.close ?? '17:00',
    };
  }
  return result;
}

export function PickupHoursForm({
  warehouseId,
  initialHours,
  initialSlotMinutes,
  initialSlotCapacity,
}: {
  warehouseId: string;
  initialHours: PickupHours;
  initialSlotMinutes: number;
  initialSlotCapacity: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [days, setDays] = useState(() => buildInitial(initialHours));
  const [slotMinutes, setSlotMinutes] = useState(initialSlotMinutes);
  const [slotCapacity, setSlotCapacity] = useState(initialSlotCapacity);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function setDay(key: DayKey, patch: Partial<{ enabled: boolean; open: string; close: string }>) {
    setDays((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function buildPayload(): PickupHours {
    const hours: PickupHours = {};
    for (const { key } of DAYS) {
      const d = days[key];
      hours[key] = d.enabled ? [{ open: d.open, close: d.close }] : [];
    }
    return hours;
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await savePickupHours(warehouseId, buildPayload(), slotMinutes, slotCapacity);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        router.refresh();
      }
    });
  }

  const rowStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '120px 40px 1fr 16px 1fr',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 0',
    borderBottom: '1px solid var(--border)',
  };

  return (
    <div style={{ display: 'grid', gap: '2rem' }}>
      {error && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: 'rgba(255,84,112,0.08)',
            border: '1px solid rgba(255,84,112,0.4)',
            borderRadius: 6,
            fontSize: 13,
            color: 'var(--danger)',
          }}
        >
          {error}
        </div>
      )}

      {/* Weekly grid */}
      <section
        style={{
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
        }}
      >
        <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.75rem' }}>Weekly schedule</h2>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
          Times are in the warehouse&apos;s local timezone.
        </div>
        {/* Header */}
        <div style={{ ...rowStyle, color: 'var(--fg-muted)', fontSize: 12 }}>
          <span>Day</span>
          <span>Open</span>
          <span>Opens at</span>
          <span />
          <span>Closes at</span>
        </div>
        {DAYS.map(({ key, label }) => {
          const d = days[key];
          return (
            <div key={key} style={rowStyle}>
              <span style={{ fontSize: 14 }}>{label}</span>
              <input
                type="checkbox"
                checked={d.enabled}
                onChange={(e) => setDay(key, { enabled: e.target.checked })}
                style={{ width: 16, height: 16 }}
              />
              <input
                type="time"
                value={d.open}
                disabled={!d.enabled}
                onChange={(e) => setDay(key, { open: e.target.value })}
                style={{ ...inputStyle, opacity: d.enabled ? 1 : 0.4 }}
              />
              <span style={{ color: 'var(--fg-muted)', textAlign: 'center' }}>–</span>
              <input
                type="time"
                value={d.close}
                disabled={!d.enabled}
                onChange={(e) => setDay(key, { close: e.target.value })}
                style={{ ...inputStyle, opacity: d.enabled ? 1 : 0.4 }}
              />
            </div>
          );
        })}
      </section>

      {/* Slot settings */}
      <section
        style={{
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '1rem',
        }}
      >
        <Field
          label="Slot length (minutes)"
          htmlFor="slotMinutes"
          hint="How long each pickup appointment slot lasts"
        >
          <input
            id="slotMinutes"
            type="number"
            min={5}
            max={240}
            step={5}
            value={slotMinutes}
            onChange={(e) => setSlotMinutes(Number(e.target.value))}
            style={inputStyle}
          />
        </Field>
        <Field
          label="Slot capacity"
          htmlFor="slotCapacity"
          hint="Max concurrent pickups per slot"
        >
          <input
            id="slotCapacity"
            type="number"
            min={1}
            max={500}
            value={slotCapacity}
            onChange={(e) => setSlotCapacity(Number(e.target.value))}
            style={inputStyle}
          />
        </Field>
      </section>

      <button onClick={handleSave} disabled={pending} style={{ ...buttonStyle, justifySelf: 'start' }}>
        {saved ? 'Saved!' : pending ? 'Saving…' : 'Save schedule'}
      </button>
    </div>
  );
}
