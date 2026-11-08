'use client';

// Client form for /account/rotate-password. Calls the
// rotatePasswordOnFirstLogin server action defined in ../actions.ts.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { rotatePasswordOnFirstLogin } from '../actions';

const inputStyle: React.CSSProperties = {
  padding: '0.6rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 4,
  width: '100%',
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

export function RotatePasswordForm() {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    const formData = new FormData();
    formData.set('newPassword', newPassword);
    startTransition(async () => {
      const result = await rotatePasswordOnFirstLogin(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Force-rotate flag now cleared. Send the user into the console.
      router.replace('/dashboard');
    });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: '0.75rem' }}>
      <input
        type="password"
        placeholder="New password (min 12 chars)"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        autoComplete="new-password"
        autoFocus
        style={inputStyle}
      />
      <input
        type="password"
        placeholder="Confirm new password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        autoComplete="new-password"
        style={inputStyle}
      />
      {error && (
        <div style={{ color: 'var(--danger, #ff8080)', fontSize: 13 }}>{error}</div>
      )}
      <button
        type="submit"
        disabled={pending || !newPassword || !confirmPassword}
        style={{
          ...buttonStyle,
          opacity: pending || !newPassword || !confirmPassword ? 0.5 : 1,
        }}
      >
        {pending ? 'Saving…' : 'Save new password'}
      </button>
    </form>
  );
}
