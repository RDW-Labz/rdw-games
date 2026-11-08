'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle, inputStyle, Field } from '@/components/Form';
import { saveAutoRelistSettings } from './auto-relist-actions';

type RelistMode = 'auto' | 'review' | 'off';

// Auto-relist has a SINGLE source of truth: `mode` (auto / review / off).
// The legacy boolean `auto_relist_enabled` is no longer a separate switch —
// the action derives it from the mode (enabled === mode === 'auto') so the
// two columns can never contradict each other. (Prior bug: an independent
// "Enable auto-relist" checkbox could be ON while mode='review', and the
// header copy then claimed lots relist "automatically" when the cron never
// would.)
export function AutoRelistForm({
  initialMaxAttempts,
  initialMode,
  canEdit,
}: {
  initialMaxAttempts: number;
  initialMode: RelistMode;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [maxAttempts, setMaxAttempts] = useState(String(initialMaxAttempts));
  const [mode, setMode] = useState<RelistMode>(initialMode);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveAutoRelistSettings({
        autoRelistMaxAttempts: Math.max(0, Math.min(10, Number(maxAttempts) || 0)),
        autoRelistMode: mode,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <section
      style={{
        marginTop: 32,
        padding: 20,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      <h2 style={{ fontSize: 16, margin: 0, marginBottom: 6 }}>Auto-relist unsold lots</h2>
      <p style={{ margin: '0 0 16px', color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.5 }}>
        Choose what happens when a lot closes without bids. In <strong>Auto</strong> it&rsquo;s
        relisted into your next eligible auction at the same warehouse until it hits the
        max-attempts limit. In <strong>Review</strong> or <strong>Off</strong> it stays in{' '}
        <strong>unsold</strong> on your Worklist (Needs re-lot) for staff to handle — relist,
        pull, donate, liquidate, etc.
      </p>

      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
        <Field
          label="When a lot lands unsold"
          hint={
            mode === 'auto'
              ? 'Auto: the system relists unsold lots into your next eligible auction automatically, up to the max-attempts limit below. The system scans every 10 minutes.'
              : mode === 'review'
                ? 'Review: unsold lots stay on your Worklist (Needs re-lot) so you can relist, pull to inventory, or dispose them by hand. Nothing relists automatically.'
                : 'Off: auto-relist is disabled. Unsold lots stay on your Worklist for manual handling.'
          }
        >
          <select
            style={{ ...inputStyle, maxWidth: 280 }}
            value={mode}
            onChange={(e) => setMode(e.target.value as RelistMode)}
            disabled={!canEdit}
          >
            <option value="auto">Auto — relist automatically</option>
            <option value="review">Review — hold for me on the Worklist</option>
            <option value="off">Off — never auto-relist</option>
          </select>
        </Field>

        <Field
          label={`Max relist attempts (${mode === 'auto' ? 'active' : 'inactive'})`}
          hint="Default 2 means each lot gets the original listing + 2 retries before manual review. Set to 0 to disable relisting even in Auto mode. Only applies in Auto mode."
        >
          <input
            style={{ ...inputStyle, maxWidth: 120 }}
            type="number"
            min={0}
            max={10}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(e.target.value)}
            disabled={!canEdit || mode !== 'auto'}
          />
        </Field>

        {error && (
          <div
            style={{
              padding: '0.5rem 0.75rem',
              background: 'rgba(248, 113, 113, 0.1)',
              border: '1px solid var(--danger, #f87171)',
              color: 'var(--danger, #f87171)',
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button type="submit" disabled={!canEdit || pending} style={buttonStyle}>
            {pending ? 'Saving…' : 'Save auto-relist settings'}
          </button>
          {saved && <span style={{ color: 'var(--success, #4ade80)', fontSize: 13 }}>✓ Saved</span>}
        </div>
        {!canEdit && (
          <p style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
            Only operator admins can change auto-relist settings.
          </p>
        )}
      </form>
    </section>
  );
}
