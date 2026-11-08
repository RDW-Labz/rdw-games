// Forgot password — sends a Supabase password reset email. The email
// links the user to /reset-password where they set a new password.

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

const inputStyle: React.CSSProperties = {
  padding: '0.6rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 4,
};

export default function ForgotPasswordPage() {
  const supabase = getSupabaseBrowser();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    if (resetError) {
      setError(resetError.message);
      return;
    }
    setSent(true);
  }

  return (
    <main style={{ padding: '4rem 2rem', maxWidth: 420, margin: '0 auto' }}>
      <h1>Reset password</h1>
      {sent ? (
        <div style={{ marginTop: '1.5rem' }}>
          <p style={{ color: 'var(--success)', lineHeight: 1.5 }}>
            If an account exists for <strong>{email}</strong>, we&apos;ve sent a reset link.
            Check your inbox (and spam folder).
          </p>
          <p style={{ marginTop: '1.5rem', color: 'var(--fg-muted)', fontSize: 14 }}>
            The link expires in 1 hour.
          </p>
          <p style={{ marginTop: '2rem' }}>
            <Link href="/login" style={{ color: 'var(--accent)' }}>
              ← Back to sign in
            </Link>
          </p>
        </div>
      ) : (
        <>
          <p style={{ color: 'var(--fg-muted)', marginTop: '0.5rem', lineHeight: 1.5 }}>
            Enter your email and we&apos;ll send you a link to set a new password.
          </p>
          <form
            onSubmit={onSubmit}
            style={{ display: 'grid', gap: '0.75rem', marginTop: '1.5rem' }}
          >
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={inputStyle}
            />
            {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
            <button
              type="submit"
              disabled={loading}
              style={{
                padding: '0.75rem',
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
              }}
            >
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
          <p
            style={{
              marginTop: '1.5rem',
              textAlign: 'center',
              color: 'var(--fg-muted)',
              fontSize: 14,
            }}
          >
            <Link href="/login" style={{ color: 'var(--fg-muted)' }}>
              ← Back to sign in
            </Link>
          </p>
        </>
      )}
    </main>
  );
}
