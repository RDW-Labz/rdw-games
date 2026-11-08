'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { dollarsToCents, formatCents } from '@auction-platform/shared';
import { inputStyle } from '@/components/Form';
import { updateLoadCost } from './actions';

interface LoadCostEditorProps {
  loadId: string;
  costCents: number | null;
  canEdit: boolean;
}

function centsToInputValue(cents: number | null): string {
  if (cents == null) return '';
  return (cents / 100).toFixed(2);
}

const smallButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 11,
  color: 'var(--fg-muted)',
  cursor: 'pointer',
};

export function LoadCostEditor({ loadId, costCents, canEdit }: LoadCostEditorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [dollars, setDollars] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) {
    return (
      <span style={{ color: costCents == null ? 'var(--fg-muted)' : undefined }}>
        {costCents != null ? formatCents(costCents) : '—'}
      </span>
    );
  }

  function startEdit() {
    setError(null);
    setDollars(centsToInputValue(costCents));
    setEditing(true);
  }

  function cancel() {
    setError(null);
    setEditing(false);
  }

  function save() {
    setError(null);
    let parsedCents: number | null;
    const trimmed = dollars.trim();
    if (trimmed === '') {
      parsedCents = null;
    } else {
      try {
        parsedCents = dollarsToCents(trimmed);
      } catch {
        setError('Enter a valid amount');
        return;
      }
    }

    startTransition(async () => {
      const result = await updateLoadCost({ loadId, costCents: parsedCents });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            style={{ ...inputStyle, width: 88, padding: '4px 8px', fontSize: 12 }}
            type="text"
            inputMode="decimal"
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
            disabled={isPending}
            autoFocus
            aria-label="Purchase cost in dollars"
          />
          <button type="button" onClick={save} disabled={isPending} style={smallButtonStyle}>
            {isPending ? '…' : 'Save'}
          </button>
          <button type="button" onClick={cancel} disabled={isPending} style={smallButtonStyle}>
            Cancel
          </button>
        </div>
        {error && <div style={{ color: 'var(--danger)', fontSize: 10 }}>{error}</div>}
      </div>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {costCents != null ? (
        <span>{formatCents(costCents)}</span>
      ) : (
        <button
          type="button"
          onClick={startEdit}
          style={{
            ...smallButtonStyle,
            color: 'var(--accent)',
            borderColor: 'var(--accent-dim, var(--border))',
          }}
        >
          Add cost
        </button>
      )}
      {costCents != null && (
        <button type="button" onClick={startEdit} style={smallButtonStyle}>
          Edit
        </button>
      )}
      {error && !editing && (
        <span style={{ color: 'var(--danger)', fontSize: 10 }}>{error}</span>
      )}
    </span>
  );
}
