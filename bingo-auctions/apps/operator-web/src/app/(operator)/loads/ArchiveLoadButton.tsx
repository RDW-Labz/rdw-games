'use client';

// Archive button shown on each row of the /loads list. Confirms before
// calling the archiveLoad server action. Soft-archive only — lots keep
// their load_id reference.

import { useState, useTransition } from 'react';
import { archiveLoad } from './actions';

interface ArchiveLoadButtonProps {
  loadId: string;
  sourceName: string;
}

export function ArchiveLoadButton({ loadId, sourceName }: ArchiveLoadButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    if (!window.confirm(`Archive load "${sourceName}"? Lots stay linked.`)) {
      return;
    }
    startTransition(async () => {
      const result = await archiveLoad(loadId);
      if (!result.ok) {
        setError(result.error);
      }
      // Success path: revalidatePath in the action refreshes the list.
    });
  }

  return (
    <span>
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: '4px 10px',
          fontSize: 11,
          color: 'var(--fg-muted)',
          cursor: isPending ? 'wait' : 'pointer',
          opacity: isPending ? 0.6 : 1,
        }}
      >
        {isPending ? 'Archiving…' : 'Archive'}
      </button>
      {error && (
        <div style={{ color: 'var(--danger)', fontSize: 10, marginTop: 4 }}>{error}</div>
      )}
    </span>
  );
}
