'use client';

// Client form for /account/security/step-up. Calls
// supabase.auth.mfa.challengeAndVerify({ factorId, code }), which:
//   • Creates a server-side challenge bound to the factor.
//   • Consumes the user's 6-digit code against that challenge.
//   • On success, mints a fresh access token at AAL2 and stores it in the
//     same cookie session. From this point on, the middleware AAL check
//     against the same session will return aal2 and the user is unblocked
//     for sensitive routes.
//
// challengeAndVerify is preferable here (vs. split challenge + verify) —
// there's no UX between the two halves on this page, so the combined
// helper avoids an extra round-trip without sacrificing error clarity.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

const inputStyle: React.CSSProperties = {
  padding: '0.6rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 4,
  width: '100%',
  fontFamily: 'monospace',
  fontSize: 18,
  letterSpacing: '0.3em',
  textAlign: 'center',
};

const buttonStyle: React.CSSProperties = {
  padding: '0.6rem 1.2rem',
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontWeight: 600,
};

export function StepUpForm({
  factorId,
  returnTo,
}: {
  factorId: string;
  returnTo: string;
}) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    const supabase = getSupabaseBrowser();
    startTransition(async () => {
      const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code: trimmed,
      });
      if (verifyErr) {
        // Per spec: clear the input field on every failure so a typo
        // doesn't linger and confuse the user when retrying.
        setError(verifyErr.message);
        setCode('');
        return;
      }
      // refresh() forces a re-fetch of the layout + middleware on the next
      // navigation so server components see the new AAL. replace() avoids
      // adding the step-up page to history.
      router.replace(returnTo);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: '0.75rem' }}>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        autoComplete="one-time-code"
        placeholder="000000"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        autoFocus
        style={inputStyle}
        aria-label="6-digit authenticator code"
      />
      {error && (
        <div style={{ color: 'var(--danger, #ff6060)', fontSize: 13 }}>{error}</div>
      )}
      <button
        type="submit"
        disabled={pending || code.length !== 6}
        style={{
          ...buttonStyle,
          opacity: pending || code.length !== 6 ? 0.5 : 1,
        }}
      >
        {pending ? 'Verifying…' : 'Continue'}
      </button>
      <p style={{ margin: '0.5rem 0 0', fontSize: 12, color: 'var(--fg-muted)' }}>
        Lost access to your authenticator?{' '}
        <a href="mailto:legal@bingoauctions.com">Email legal@bingoauctions.com</a> to
        reset it manually.
      </p>
    </form>
  );
}
