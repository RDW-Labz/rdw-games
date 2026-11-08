'use client';

// Campaign control panel (mig 0292). One card per campaign: what it is, who is
// eligible right now, how it performed, and the two controls that matter
// (on/off + send now).
//
// Deliberately shows `audience_now` next to `emails_sent` — the gap between
// "people in this segment" and "people we have actually reached" is the whole
// point of the page. A campaign sitting at 268 eligible / 0 sent is money on
// the floor, and that should be obvious at a glance.

import { useState, useTransition } from 'react';
import { setCampaignEnabled, sendCampaignNow } from './actions';

export type CampaignCardRow = {
  slug: string;
  name: string;
  description: string;
  audience: string;
  enabled: boolean;
  lotStrategy: string;
  cadenceHours: number;
  cooldownHours: number;
  maxPerBidder: number;
  audienceNow: number;
  emailsSent: number;
  biddersReached: number;
  bidAfter: number;
  boughtAfter: number;
  revenueAfterCents: number;
  lastRunAt: string | null;
  lastRunLabel: string | null;
};

const STRATEGY_LABEL: Record<string, string> = {
  closing_soon: 'Lots closing soon',
  cheapest: 'Cheapest live lots',
  newest: 'Newest listings',
  none: 'No lot grid',
};

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtHours(h: number): string {
  if (h % 168 === 0) return `${h / 168}w`;
  if (h % 24 === 0) return `${h / 24}d`;
  return `${h}h`;
}

export function CampaignPanel({ campaigns }: { campaigns: CampaignCardRow[] }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ slug: string; ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  function toggle(slug: string, next: boolean) {
    startTransition(async () => {
      const r = await setCampaignEnabled(slug, next);
      setMsg({ slug, ok: r.ok, text: r.message });
    });
  }

  function send(slug: string) {
    setConfirming(null);
    startTransition(async () => {
      const r = await sendCampaignNow(slug);
      setMsg({ slug, ok: r.ok, text: r.message });
    });
  }

  return (
    <div style={{ display: 'grid', gap: '0.9rem' }}>
      {campaigns.map((c) => (
        <div
          key={c.slug}
          style={{
            border: '1px solid var(--border)',
            borderLeft: `3px solid ${c.enabled ? 'var(--accent)' : 'var(--border)'}`,
            background: 'var(--bg-elev)',
            borderRadius: 8,
            padding: '0.9rem 1rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: '1 1 320px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 15 }}>{c.name}</strong>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '2px 7px',
                    borderRadius: 4,
                    background: c.enabled ? 'rgba(34,197,94,0.15)' : 'var(--bg)',
                    color: c.enabled ? 'var(--accent)' : 'var(--fg-dim)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {c.enabled ? 'ON' : 'OFF'}
                </span>
                <code style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{c.slug}</code>
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0.4rem 0 0', lineHeight: 1.5 }}>
                {c.description}
              </p>
              <div style={{ fontSize: 11.5, color: 'var(--fg-dim)', marginTop: '0.4rem' }}>
                {STRATEGY_LABEL[c.lotStrategy] ?? c.lotStrategy} · runs at most every{' '}
                {fmtHours(c.cadenceHours)} · max {c.maxPerBidder} per bidder ever, no more than one
                every {fmtHours(c.cooldownHours)}
                {c.lastRunLabel ? ` · last sent ${c.lastRunLabel}` : ' · never sent'}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', flexShrink: 0 }}>
              <button
                onClick={() => toggle(c.slug, !c.enabled)}
                disabled={pending}
                style={btn(c.enabled ? 'ghost' : 'primary')}
              >
                {c.enabled ? 'Turn off' : 'Turn on'}
              </button>
              {confirming === c.slug ? (
                <>
                  <button onClick={() => send(c.slug)} disabled={pending} style={btn('danger')}>
                    Confirm — email {c.audienceNow}
                  </button>
                  <button onClick={() => setConfirming(null)} disabled={pending} style={btn('ghost')}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirming(c.slug)}
                  disabled={pending || c.audienceNow === 0}
                  style={btn('ghost')}
                  title={c.audienceNow === 0 ? 'Nobody is eligible right now' : undefined}
                >
                  Send now
                </button>
              )}
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
              gap: '0.5rem',
              marginTop: '0.8rem',
              paddingTop: '0.7rem',
              borderTop: '1px solid var(--border)',
            }}
          >
            <Stat label="Eligible now" value={c.audienceNow} accent={c.audienceNow > 0 && c.emailsSent === 0} />
            <Stat label="Emails sent" value={c.emailsSent} />
            <Stat label="People reached" value={c.biddersReached} />
            <Stat label="Bid after" value={c.bidAfter} />
            <Stat label="Bought after" value={c.boughtAfter} />
            <Stat label="Revenue after" value={fmtMoney(c.revenueAfterCents)} />
          </div>

          {msg?.slug === c.slug && (
            <p
              style={{
                fontSize: 12.5,
                margin: '0.7rem 0 0',
                color: msg.ok ? 'var(--accent)' : 'var(--danger)',
              }}
            >
              {msg.text}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--fg-dim)' }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: accent ? 'var(--warn, #f59e0b)' : 'var(--fg)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function btn(kind: 'primary' | 'ghost' | 'danger'): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '0.4rem 0.75rem',
    fontSize: 12.5,
    fontWeight: 600,
    borderRadius: 6,
    cursor: 'pointer',
    border: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  };
  if (kind === 'primary') return { ...base, background: 'var(--accent)', color: '#fff', borderColor: 'transparent' };
  if (kind === 'danger') return { ...base, background: 'var(--danger)', color: '#fff', borderColor: 'transparent' };
  return { ...base, background: 'var(--bg)', color: 'var(--fg)' };
}
