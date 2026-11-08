'use client';

// Account settings client form. Two cases:
//   - User HAS a password already → "Change password" UX (old + new)
//   - User has NO password (Google/Apple OAuth only) → "Set a password"
//     UX (new password + confirm). This lets a Google-sign-in operator
//     add an email/password fallback for the mobile apps without going
//     through /forgot-password (which hits Supabase's email rate limit
//     and confuses users who never had a password to "reset").
//
// Both flows call supabase.auth.updateUser({ password }) — Supabase
// treats "set" and "change" as the same operation when the user has a
// valid session, no email round-trip needed.
//
// Also lists the linked auth identities so the user understands which
// methods will keep working after setting a password (all of them — the
// new password is additive, not a replacement).

import { useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { updateDisplayName } from './actions';

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

export function AccountForm({
  hasPassword,
  hasGoogle,
  hasApple,
  displayName: initialDisplayName,
}: {
  hasPassword: boolean;
  hasGoogle: boolean;
  hasApple: boolean;
  displayName: string | null;
}) {
  const supabase = getSupabaseBrowser();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // Display name state
  const [displayName, setDisplayName] = useState(initialDisplayName ?? '');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSavedAt, setNameSavedAt] = useState<Date | null>(null);

  async function onSaveName(e: React.FormEvent) {
    e.preventDefault();
    setNameError(null);
    setNameSaving(true);
    const result = await updateDisplayName(displayName.trim() || null);
    setNameSaving(false);
    if (!result.ok) {
      setNameError(result.error ?? 'Failed to save display name.');
    } else {
      setNameSavedAt(new Date());
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedAt(null);
    if (newPassword.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setSaving(true);
    const { error: updateErr } = await supabase.auth.updateUser({ password: newPassword });
    setSaving(false);
    if (updateErr) {
      setError(updateErr.message);
      return;
    }
    setSavedAt(new Date());
    setNewPassword('');
    setConfirmPassword('');
  }

  return (
    <div style={{ display: 'grid', gap: '2rem' }}>
      {/* ── Linked sign-in methods ─────────────────────────────────────── */}
      <section
        style={{
          padding: '1rem 1.25rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 16 }}>How you sign in</h2>
        <ul style={{ margin: 0, paddingLeft: '1.25rem', color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.7 }}>
          <li>
            Email + password —{' '}
            <strong style={{ color: hasPassword ? 'var(--accent)' : 'var(--fg-muted)' }}>
              {hasPassword ? 'Active' : 'Not set'}
            </strong>
          </li>
          <li>
            Continue with Google —{' '}
            <strong style={{ color: hasGoogle ? 'var(--accent)' : 'var(--fg-muted)' }}>
              {hasGoogle ? 'Linked' : 'Not linked'}
            </strong>
          </li>
          <li>
            Continue with Apple —{' '}
            <strong style={{ color: hasApple ? 'var(--accent)' : 'var(--fg-muted)' }}>
              {hasApple ? 'Linked' : 'Not linked'}
            </strong>
          </li>
        </ul>
        {!hasPassword && (
          <p style={{ marginTop: '0.75rem', marginBottom: 0, fontSize: 13, color: 'var(--fg-muted)' }}>
            You signed up with Google or Apple — your account works perfectly on the web
            console using those buttons. To sign in on the <strong>BinGo Staff app</strong> (and the
            warehouse / picker flows), you need to set an email + password below. Your
            Google / Apple sign-in keeps working too.
          </p>
        )}
      </section>

      {/* ── Display name ──────────────────────────────────────────────── */}
      <section>
        <h2 style={{ fontSize: 16, marginBottom: '0.25rem' }}>Display name</h2>
        <p style={{ marginTop: 0, fontSize: 13, color: 'var(--fg-muted)' }}>
          How your name appears to other staff. Leave blank to show your email address.
        </p>
        <form onSubmit={onSaveName} style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
          <input
            type="text"
            placeholder="e.g. Alex Smith"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
            style={inputStyle}
          />
          {nameError && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{nameError}</div>}
          {nameSavedAt && (
            <div style={{ color: 'var(--accent)', fontSize: 13 }}>
              Display name saved {nameSavedAt.toLocaleTimeString()}.
            </div>
          )}
          <button
            type="submit"
            disabled={nameSaving}
            style={{ ...buttonStyle, justifySelf: 'start', opacity: nameSaving ? 0.5 : 1 }}
          >
            {nameSaving ? 'Saving…' : 'Save name'}
          </button>
        </form>
      </section>

      {/* ── Set / change password ──────────────────────────────────────── */}
      <section>
        <h2 style={{ fontSize: 16, marginBottom: '0.25rem' }}>
          {hasPassword ? 'Change password' : 'Set a password'}
        </h2>
        <p style={{ marginTop: 0, fontSize: 13, color: 'var(--fg-muted)' }}>
          Minimum 12 characters. Use anything memorable to you — a passphrase works fine.
        </p>
        <form onSubmit={onSubmit} style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
          <input
            type="password"
            placeholder={hasPassword ? 'New password' : 'Password (min 12 chars)'}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            style={inputStyle}
          />
          {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
          {savedAt && (
            <div style={{ color: 'var(--accent)', fontSize: 13 }}>
              Password updated {savedAt.toLocaleTimeString()}. You can sign in with this on
              every app now.
            </div>
          )}
          <button
            type="submit"
            disabled={saving || !newPassword || !confirmPassword}
            style={{
              ...buttonStyle,
              justifySelf: 'start',
              opacity: saving || !newPassword || !confirmPassword ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}
          </button>
        </form>
      </section>
    </div>
  );
}
