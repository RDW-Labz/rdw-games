// Client form for /profile/delete-account. Mirrors the mobile screen
// (apps/bidder-app/app/profile/delete-account.tsx): type-your-email confirm,
// then the destructive button calls `delete_my_account` (idempotent; tombstones
// rather than hard-deletes per migration 0089), signs out, and goes home.

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

interface DeleteAccountFormProps {
  accountEmail: string;
}

export function DeleteAccountForm({ accountEmail }: DeleteAccountFormProps) {
  const router = useRouter();
  const [typedEmail, setTypedEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isConfirmed =
    accountEmail.length > 0 &&
    typedEmail.trim().toLowerCase() === accountEmail.trim().toLowerCase();

  async function handleDelete() {
    if (!isConfirmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      const { error: rpcErr } = await supabase.rpc('delete_my_account');
      if (rpcErr) {
        setError(rpcErr.message);
        setSubmitting(false);
        return;
      }
      // Tombstoned server-side; clear the local session too, then go home.
      await supabase.auth.signOut();
      router.replace('/?account_deleted=1');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div>
      <label
        htmlFor="confirm-email"
        style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 6 }}
      >
        To confirm, type your email address:
      </label>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 8 }}>
        {accountEmail || 'No email on file'}
      </div>
      <input
        id="confirm-email"
        type="email"
        value={typedEmail}
        onChange={(e) => setTypedEmail(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Type your email to confirm"
        disabled={submitting}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '0.7rem 0.85rem',
          color: 'var(--fg)',
          fontSize: 15,
          marginBottom: 16,
        }}
      />

      {error && (
        <div
          role="alert"
          style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleDelete}
        disabled={!isConfirmed || submitting}
        style={{
          width: '100%',
          padding: '0.8rem 1rem',
          background: isConfirmed ? 'var(--danger)' : 'var(--bg-elev)',
          color: isConfirmed ? '#fff' : 'var(--fg-dim)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontWeight: 800,
          fontSize: 15,
          cursor: isConfirmed && !submitting ? 'pointer' : 'not-allowed',
          opacity: submitting ? 0.6 : 1,
          marginBottom: 12,
        }}
      >
        {submitting ? 'Deleting…' : 'Permanently delete my account'}
      </button>
    </div>
  );
}
