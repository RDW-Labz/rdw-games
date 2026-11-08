'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle } from '@/components/Form';
import { setPickupMode, type PickupMode } from './actions';

export function PickupModeForm({
  warehouseId,
  initialMode,
  options,
}: {
  warehouseId: string;
  initialMode: PickupMode;
  options: Array<{ value: PickupMode; title: string; blurb: string; bestFor: string; floorPlanNote?: string }>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<PickupMode>(initialMode);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = selected !== initialMode;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await setPickupMode(warehouseId, selected);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={onSubmit}>
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        {options.map((opt) => {
          const isSelected = selected === opt.value;
          return (
            <label
              key={opt.value}
              style={{
                display: 'block',
                padding: '1rem',
                background: 'var(--bg-elev)',
                border: `2px solid ${isSelected ? 'var(--accent, #4f8cff)' : 'var(--border)'}`,
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                <input
                  type="radio"
                  name="pickup_mode"
                  value={opt.value}
                  checked={isSelected}
                  onChange={() => setSelected(opt.value)}
                  style={{ marginTop: 2 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{opt.title}</div>
                  <p style={{ margin: '0.4rem 0 0', fontSize: 13, lineHeight: 1.5 }}>{opt.blurb}</p>
                  <p
                    style={{
                      margin: '0.4rem 0 0',
                      fontSize: 12,
                      color: 'var(--fg-muted)',
                      lineHeight: 1.5,
                    }}
                  >
                    {opt.bestFor}
                  </p>
                  {opt.floorPlanNote && (
                    <p
                      style={{
                        margin: '0.5rem 0 0',
                        fontSize: 12,
                        color: 'var(--warning, #f59e0b)',
                        lineHeight: 1.5,
                        borderLeft: '3px solid var(--warning, #f59e0b)',
                        paddingLeft: '0.5rem',
                      }}
                    >
                      {opt.floorPlanNote}
                    </p>
                  )}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      <div
        style={{
          marginTop: '1.5rem',
          display: 'flex',
          gap: '1rem',
          alignItems: 'center',
        }}
      >
        <button
          type="submit"
          disabled={!dirty || pending}
          style={{
            ...buttonStyle,
            opacity: !dirty || pending ? 0.5 : 1,
            cursor: !dirty || pending ? 'not-allowed' : 'pointer',
          }}
        >
          {pending ? 'Saving…' : dirty ? 'Save mode' : 'Saved'}
        </button>
        {saved && !dirty && (
          <span style={{ color: 'var(--success, #4ade80)', fontSize: 13 }}>✓ Saved</span>
        )}
        {error && <span style={{ color: 'var(--danger, #f87171)', fontSize: 13 }}>{error}</span>}
      </div>
    </form>
  );
}
