'use client';

// Per-row resolve actions for the Missing Items report (mig 0426).
//   open:        Found (bin code) · Confirmed missing · Unsellable
//   unsellable:  Record disposal (how it left)
// Confirmed missing and Unsellable are admin/manager only; the RPC enforces it,
// the buttons just aren't offered to pickers.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { DISPOSAL_KINDS, type MissingState } from '@/lib/missing-items-report';
import { confirmMissing, markFound, markUnsellable, type BinChoice, type FoundResult, type MissingActionResult } from './actions';

type Mode = null | 'found' | 'missing' | 'unsellable' | 'dispose';

const btn: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg)',
  cursor: 'pointer',
};
const input: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  minWidth: 0,
};

export function MissingRowActions({
  lotId,
  state,
  canManage,
}: {
  lotId: string;
  state: MissingState;
  canManage: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [binCode, setBinCode] = useState('');
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<(typeof DISPOSAL_KINDS)[number]>('destroyed');
  const [error, setError] = useState<string | null>(null);
  // Set when the typed bin code matched more than one bin: staff pick one.
  const [choices, setChoices] = useState<BinChoice[] | null>(null);
  const [pending, start] = useTransition();

  if (state !== 'open' && state !== 'unsellable') return null;

  function run(fn: () => Promise<MissingActionResult | FoundResult>) {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setError(r.error);
        setChoices('choices' in r ? r.choices : null);
        return;
      }
      setMode(null);
      setNote('');
      setBinCode('');
      setChoices(null);
      router.refresh();
    });
  }

  const noteInput = (
    <input
      style={{ ...input, flex: 1 }}
      placeholder="Note (optional)"
      value={note}
      maxLength={500}
      onChange={(e) => setNote(e.target.value)}
    />
  );

  return (
    <div className="no-print" style={{ display: 'grid', gap: 6, minWidth: 220 }}>
      {mode === null && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {state === 'open' && (
            <>
              <button type="button" style={btn} onClick={() => setMode('found')}>
                Found
              </button>
              {canManage && (
                <>
                  <button type="button" style={btn} onClick={() => setMode('missing')}>
                    Confirmed missing
                  </button>
                  <button type="button" style={btn} onClick={() => setMode('unsellable')}>
                    Unsellable
                  </button>
                </>
              )}
            </>
          )}
          {state === 'unsellable' && canManage && (
            <button type="button" style={btn} onClick={() => setMode('dispose')}>
              Record disposal
            </button>
          )}
        </div>
      )}

      {mode === 'found' && (
        <form
          style={{ display: 'grid', gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => markFound({ lotId, binCode, note: note || undefined }));
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Put it away: the bin it is going on now.
          </span>
          <input
            style={input}
            placeholder="Bin code"
            value={binCode}
            autoFocus
            onChange={(e) => {
              setBinCode(e.target.value);
              setChoices(null);
            }}
          />
          {choices && choices.length > 1 && (
            <div role="group" aria-label="Pick the bin" style={{ display: 'grid', gap: 4 }}>
              {choices.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  style={btn}
                  disabled={pending}
                  onClick={() => run(() => markFound({ lotId, binCode, note: note || undefined, binId: c.id }))}
                >
                  {c.code} · {c.warehouse}
                </button>
              ))}
            </div>
          )}
          {noteInput}
          <Row pending={pending} label="Put away" onCancel={() => { setMode(null); setChoices(null); }} />
        </form>
      )}

      {mode === 'missing' && (
        <form
          style={{ display: 'grid', gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => confirmMissing({ lotId, note: note || undefined }));
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Writes it off and removes it from inventory.
          </span>
          {noteInput}
          <Row pending={pending} label="Write off" danger onCancel={() => setMode(null)} />
        </form>
      )}

      {mode === 'unsellable' && (
        <form
          style={{ display: 'grid', gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => markUnsellable({ lotId, note: note || undefined }));
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Found but can&apos;t be sold. Marks it for disposal; record the disposal when done.
          </span>
          {noteInput}
          <Row pending={pending} label="Mark for disposal" onCancel={() => setMode(null)} />
        </form>
      )}

      {mode === 'dispose' && (
        <form
          style={{ display: 'grid', gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => markUnsellable({ lotId, note: note || undefined, disposalKind: kind }));
          }}
        >
          <select
            style={input}
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof DISPOSAL_KINDS)[number])}
          >
            {DISPOSAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          {noteInput}
          <Row pending={pending} label="Disposal done" onCancel={() => setMode(null)} />
        </form>
      )}

      {error && <span style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 600 }}>{error}</span>}
    </div>
  );
}

function Row({
  pending,
  label,
  danger,
  onCancel,
}: {
  pending: boolean;
  label: string;
  danger?: boolean;
  onCancel: () => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button
        type="submit"
        disabled={pending}
        style={{
          ...btn,
          background: danger ? 'var(--danger)' : 'var(--accent)',
          color: '#000',
          borderColor: 'transparent',
          opacity: pending ? 0.5 : 1,
        }}
      >
        {pending ? 'Saving…' : label}
      </button>
      <button type="button" style={btn} disabled={pending} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
