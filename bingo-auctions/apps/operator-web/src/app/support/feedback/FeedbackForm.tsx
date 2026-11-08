'use client';

// The public feedback form (0327).
//
// Under /support because that is where someone already goes when something is
// wrong, and because /support is on the middleware's public prefix list — this
// page has to work for a visitor with no session, which is the whole point.
//
// No sign-in, no account, email optional. Every field asked for is a field
// somebody abandons the form over, and a report we never receive helps nobody.

import { useState } from 'react';

type Kind = 'bug' | 'idea';

export function FeedbackForm() {
  const [kind, setKind] = useState<Kind>('bug');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = message.trim().length < 10;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || tooShort) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          message,
          contact_email: email,
          website,
          page: typeof window !== 'undefined' ? window.location.pathname : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Something went wrong. Please email support@bingoauctions.com.');
        return;
      }
      setDone(true);
    } catch {
      setError('Network problem — please try again, or email support@bingoauctions.com.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div style={panel}>
        <strong>Thank you — that came through.</strong>
        <p style={{ margin: '0.5rem 0 0', fontSize: 14 }}>
          {email.trim()
            ? "If we need more detail we'll email you."
            : 'You did not leave an email, so we cannot reply — but a person reads every one of these.'}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {(['bug', 'idea'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            style={{
              flex: '1 1 12rem',
              padding: '0.75rem 1rem',
              borderRadius: 8,
              fontSize: 15,
              cursor: 'pointer',
              border: `1px solid ${kind === k ? 'var(--accent, #2563eb)' : 'var(--border, #d0d7de)'}`,
              background: kind === k ? 'var(--accent, #2563eb)' : 'transparent',
              color: kind === k ? '#fff' : 'inherit',
            }}
          >
            {k === 'bug' ? 'Something went wrong' : 'I have a suggestion'}
          </button>
        ))}
      </div>

      <label htmlFor="fb-message" style={label}>
        {kind === 'bug' ? 'What happened?' : "What's your suggestion?"}
      </label>
      <textarea
        id="fb-message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={6}
        maxLength={4000}
        placeholder={
          kind === 'bug'
            ? 'e.g. I tried to pay my invoice on my phone and the page kept reloading.'
            : 'e.g. Show the pickup window on the invoice email.'
        }
        style={input}
      />

      <label htmlFor="fb-email" style={label}>
        Email (optional — only so we can reply)
      </label>
      <input
        id="fb-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        style={input}
      />

      {/* Honeypot: off-screen, not display:none — some bots skip hidden fields
          but fill anything they can read in the DOM. */}
      <div style={{ position: 'absolute', left: '-9999px' }} aria-hidden="true">
        <label htmlFor="fb-website">Website</label>
        <input
          id="fb-website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      {error && (
        <p style={{ color: 'var(--danger, #b42318)', fontSize: 14, marginTop: '0.75rem' }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || tooShort}
        style={{
          marginTop: '1rem',
          padding: '0.75rem 1.5rem',
          borderRadius: 8,
          border: 'none',
          background: 'var(--accent, #2563eb)',
          color: '#fff',
          fontSize: 15,
          fontWeight: 600,
          cursor: busy || tooShort ? 'default' : 'pointer',
          opacity: busy || tooShort ? 0.5 : 1,
        }}
      >
        {busy ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}

const label: React.CSSProperties = {
  display: 'block',
  marginTop: '1.25rem',
  marginBottom: '0.375rem',
  fontSize: 13,
  fontWeight: 600,
};

const input: React.CSSProperties = {
  width: '100%',
  padding: '0.625rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border, #d0d7de)',
  background: 'var(--bg, #fff)',
  color: 'inherit',
  fontSize: 15,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const panel: React.CSSProperties = {
  marginTop: '1.5rem',
  padding: '1rem 1.25rem',
  borderRadius: 8,
  border: '1px solid var(--border, #d0d7de)',
  background: 'var(--bg-elev, #f6f8fa)',
};
