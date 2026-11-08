'use client';

// Square Loyalty card on the bidder profile (mig 0237, Phase 2). Shows the
// live points balance + the program's reward tiers and converts a tier into
// BinGo credit (applied automatically to the next invoice). Renders nothing
// while the feature is off or the bidder has no phone — the profile stays
// clean for the common case.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type LoyaltyState = {
  enabled: boolean;
  reason?: string;
  balance?: number;
  terminology?: { one: string; other: string };
  tiers?: Array<{ id: string; points: number; name: string; credit_cents: number | null }>;
};

export function LoyaltyCard() {
  const router = useRouter();
  const [state, setState] = useState<LoyaltyState | null>(null);
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void fetch('/api/bidder/loyalty', { credentials: 'include' })
      .then((r) => r.json())
      .then((j: LoyaltyState) => setState(j))
      .catch(() => setState({ enabled: false, reason: 'network' }));
  }, []);

  if (!state) return null;
  if (!state.enabled && state.reason !== 'no_phone') return null;

  // Loyalty is ON but this bidder has no phone — loyalty accounts are
  // phone-keyed, so offer the one-field fix inline.
  if (!state.enabled && state.reason === 'no_phone') {
    return <AddPhoneForLoyalty onSaved={() => {
      void fetch('/api/bidder/loyalty', { credentials: 'include' })
        .then((r) => r.json())
        .then((j: LoyaltyState) => setState(j));
    }} />;
  }

  const pts = state.terminology ?? { one: 'Point', other: 'Points' };
  const balance = state.balance ?? 0;
  const tiers = (state.tiers ?? []).filter((t) => t.credit_cents && t.credit_cents > 0);

  const redeem = async (tierId: string, creditCents: number, points: number) => {
    if (!window.confirm(`Redeem ${points} ${pts.other.toLowerCase()} for $${(creditCents / 100).toFixed(2)} auction credit? Points are spent immediately.`)) {
      return;
    }
    setBusyTier(tierId);
    setMessage(null);
    try {
      const res = await fetch('/api/bidder/loyalty/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tier_id: tierId, redemption_id: crypto.randomUUID() }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string; credit_cents?: number };
      if (!j.ok) {
        setMessage({ ok: false, text: j.error ?? 'Redemption failed.' });
      } else {
        setMessage({
          ok: true,
          text: `$${((j.credit_cents ?? creditCents) / 100).toFixed(2)} credit added — it applies to your next invoice automatically.`,
        });
        // Refresh balance + the server-rendered credit balance elsewhere on the page.
        const fresh = (await fetch('/api/bidder/loyalty', { credentials: 'include' }).then((r) => r.json())) as LoyaltyState;
        setState(fresh);
        router.refresh();
      }
    } catch {
      setMessage({ ok: false, text: 'Network error — your points are safe, try again.' });
    } finally {
      setBusyTier(null);
    }
  };

  return (
    <section
      style={{
        marginBottom: '2rem',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '1.25rem 1.5rem',
      }}
    >
      <h2
        style={{
          fontSize: '0.9rem',
          fontWeight: 800,
          textTransform: 'uppercase',
          letterSpacing: 1.5,
          color: 'var(--fg-dim)',
          margin: '0 0 1rem',
        }}
      >
        Loyalty points
      </h2>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 26, fontWeight: 900, color: 'var(--accent)' }}>{balance}</span>
        <span style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
          {balance === 1 ? pts.one : pts.other} — earned at BinGo auctions and our stores, spendable at both.
        </span>
      </div>
      {tiers.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {tiers.map((t) => (
            <button
              key={t.id}
              type="button"
              className="btn-secondary"
              disabled={busyTier !== null || balance < t.points}
              onClick={() => redeem(t.id, t.credit_cents!, t.points)}
              style={{
                padding: '0.55rem 1.1rem',
                fontSize: 13,
                cursor: balance < t.points ? 'not-allowed' : 'pointer',
                opacity: balance < t.points ? 0.5 : 1,
              }}
            >
              {busyTier === t.id
                ? 'Redeeming…'
                : `${t.points} ${pts.other.toLowerCase()} → $${(t.credit_cents! / 100).toFixed(2)} credit`}
            </button>
          ))}
        </div>
      )}
      {message && (
        <div
          style={{
            marginTop: 10,
            fontSize: 13,
            color: message.ok ? 'var(--accent)' : 'var(--danger)',
          }}
        >
          {message.text}
        </div>
      )}
    </section>
  );
}

function AddPhoneForLoyalty({ onSaved }: { onSaved: () => void }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/bidder/phone', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string };
      if (!j.ok) setError(j.error ?? 'Save failed.');
      else onSaved();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      style={{
        marginBottom: '2rem',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '1.25rem 1.5rem',
      }}
    >
      <h2
        style={{
          fontSize: '0.9rem',
          fontWeight: 800,
          textTransform: 'uppercase',
          letterSpacing: 1.5,
          color: 'var(--fg-dim)',
          margin: '0 0 1rem',
        }}
      >
        Loyalty points
      </h2>
      <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginBottom: 10 }}>
        Auction wins earn the same loyalty points as our stores — add your phone number to start
        collecting (it&apos;s how your points account is identified at the register too).
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(555) 555-5555"
          maxLength={20}
          autoComplete="tel"
          style={{
            padding: '0.6rem 0.8rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            borderRadius: 6,
            fontSize: 14,
            minWidth: 200,
          }}
        />
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={save}
          style={{ padding: '0.6rem 1.2rem', fontSize: 14, cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy ? 'Saving…' : 'Start earning points'}
        </button>
      </div>
      {error && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--danger)' }}>{error}</div>}
    </section>
  );
}
