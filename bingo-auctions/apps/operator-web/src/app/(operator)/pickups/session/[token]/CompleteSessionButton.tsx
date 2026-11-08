'use client';

// One-tap "complete everything" for the pickup-session counter page.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { completeSession, type CompleteSessionResult } from './actions';

export function CompleteSessionButton({ token, paidCount }: { token: string; paidCount: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CompleteSessionResult | null>(null);

  const run = async () => {
    if (!window.confirm(`Complete pickup for ${paidCount} paid invoice${paidCount === 1 ? '' : 's'}?`)) return;
    setBusy(true);
    try {
      const res = await completeSession(token);
      setResult(res);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        className="btn-primary"
        disabled={busy}
        onClick={run}
        style={{ padding: '0.9rem 1.6rem', fontSize: 15, fontWeight: 800, cursor: busy ? 'wait' : 'pointer' }}
      >
        {busy ? 'Completing…' : `Complete ${paidCount} paid pickup${paidCount === 1 ? '' : 's'} ✓`}
      </button>
      {result && (
        <div style={{ marginTop: 10, fontSize: 13, color: result.ok ? 'var(--accent)' : 'var(--danger)' }}>
          {result.completed > 0 && <>Completed {result.completed}. </>}
          {result.skippedUnpaid > 0 && <>{result.skippedUnpaid} unpaid skipped — collect payment and scan again. </>}
          {result.leftOpen > 0 && <>{result.leftOpen} invoice{result.leftOpen === 1 ? '' : 's'} left open for a return trip. </>}
          {result.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
    </div>
  );
}
