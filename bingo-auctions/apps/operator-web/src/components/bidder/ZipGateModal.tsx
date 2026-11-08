// Mandatory ZIP gate overlay — the web counterpart of the bidder app's
// ZipGateHost. Shown once, on the bidder's next bid or checkout action, if
// they have no ZIP on file. Styled after OffsiteNoticeModal (lot/[code])
// since it is the closest existing "blocking gate before a bid" dialog.
//
// The caller owns WHEN this renders (it checks bidderHasZip first) and WHAT
// happens after: onSaved() resumes the action that was waiting on this,
// onCancel() just closes it (nothing is placed/charged).

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { makeZipChecker, saveBidderZip } from '@/lib/zip-gate-browser';

export function ZipGateModal({
  onSaved,
  onCancel,
}: {
  onSaved: () => void;
  onCancel: () => void;
}) {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const checker = useRef(makeZipChecker(supabase));
  const [zip, setZip] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !saving) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, saving]);

  async function save() {
    setError(null);
    setSaving(true);
    const result = await checker.current.check(zip);
    if (!result.ok) {
      setSaving(false);
      setError(result.error);
      return;
    }
    const res = await saveBidderZip(supabase, result.zip);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="zip-gate-title"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.65)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: '100%',
          maxWidth: 420,
          padding: '1.5rem',
        }}
      >
        <div id="zip-gate-title" style={{ fontSize: '1.15rem', fontWeight: 900 }}>
          Your ZIP code
        </div>
        <p style={{ fontSize: 13, color: 'var(--fg-dim)', marginTop: 6, lineHeight: 1.5 }}>
          One-time — we need this before you bid or check out.
        </p>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={5}
          autoFocus
          value={zip}
          onChange={(e) => {
            setZip(e.target.value.replace(/[^0-9]/g, '').slice(0, 5));
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
          placeholder="ZIP code"
          aria-label="ZIP code"
          style={{
            marginTop: 14,
            width: '100%',
            padding: '0.85rem',
            fontSize: 18,
            letterSpacing: 2,
            borderRadius: 8,
            border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
            background: 'var(--bg)',
            color: 'var(--fg)',
          }}
        />
        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8, fontWeight: 600 }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.6rem', marginTop: 18 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="btn-secondary"
            style={{ flex: 1, padding: '0.85rem', opacity: saving ? 0.5 : 1 }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="btn-primary"
            style={{
              flex: 1,
              padding: '0.85rem',
              opacity: saving ? 0.7 : 1,
              cursor: saving ? 'wait' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
