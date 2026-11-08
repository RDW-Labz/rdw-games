'use client';

// PublishFloorPlanButton — S10 floor-plan publisher client component.
//
// Calls publishFloorPlan(warehouseId), shows busy/done/error states.
// Rendered by the walk page when scanned_count === total (all bins verified).

import { useState } from 'react';
import { publishFloorPlan, type PublishFloorPlanResult } from './actions';

interface Props {
  warehouseId: string;
}

type Status = 'idle' | 'busy' | 'done' | 'error';

export function PublishFloorPlanButton({ warehouseId }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<PublishFloorPlanResult | null>(null);

  async function handleClick() {
    setStatus('busy');
    setResult(null);
    try {
      const res = await publishFloorPlan(warehouseId);
      setResult(res);
      setStatus(res.ok ? 'done' : 'error');
    } catch (err: unknown) {
      setResult({
        ok: false,
        error: err instanceof Error ? err.message : 'Unexpected error',
      });
      setStatus('error');
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={status === 'busy' || status === 'done'}
        style={{
          padding: '0.6rem 1.25rem',
          background:
            status === 'done'
              ? 'var(--success-dim)'
              : status === 'error'
                ? 'var(--urgent-red-dim)'
                : 'var(--accent)',
          border:
            status === 'done'
              ? '1px solid var(--success)'
              : status === 'error'
                ? '1px solid var(--danger)'
                : '1px solid var(--accent)',
          borderRadius: 6,
          color:
            status === 'done'
              ? 'var(--success)'
              : status === 'error'
                ? 'var(--danger)'
                : 'var(--accent-fg, #fff)',
          fontSize: 14,
          fontWeight: 600,
          cursor: status === 'busy' || status === 'done' ? 'default' : 'pointer',
          opacity: status === 'busy' ? 0.7 : 1,
          transition: 'opacity 0.15s',
        }}
      >
        {status === 'busy'
          ? 'Publishing…'
          : status === 'done'
            ? 'Floor plan published!'
            : status === 'error'
              ? 'Retry publish'
              : 'Publish floor plan'}
      </button>

      {status === 'done' && result?.ok && (
        <p
          style={{
            marginTop: '0.5rem',
            fontSize: 12,
            color: 'var(--success)',
          }}
        >
          {result.binCount} bin{result.binCount !== 1 ? 's' : ''} mapped.{' '}
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--success)', textDecoration: 'underline' }}
          >
            View SVG
          </a>
        </p>
      )}

      {status === 'error' && result && !result.ok && (
        <p
          style={{
            marginTop: '0.5rem',
            fontSize: 12,
            color: 'var(--danger)',
          }}
        >
          {result.error}
        </p>
      )}
    </div>
  );
}
