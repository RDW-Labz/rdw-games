'use client';

// Post-win share prompt on the bidder receipt page (marketing batch,
// 2026-07-05). Winners bragging is the best ad a liquidation auction has —
// the prompt bakes their referral code into the share text so the brag
// feeds the Give $5/get $5 engine.

import { useEffect, useState } from 'react';
import { beaconShareClick } from '../../(public)/_components/ShareBar';

const APP_URL = 'https://bingoauctions.com';

export function WinShareCard({
  code,
  totalCents,
}: {
  code: string;
  totalCents: number;
}) {
  const [copied, setCopied] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);

  useEffect(() => {
    setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  const price = `$${(totalCents / 100).toFixed(totalCents % 100 === 0 ? 0 : 2)}`;
  const shareText = `Just scored a deal for ${price} at BinGo Auctions 🎉 Sign up with my code ${code} and we both get $5 off: ${APP_URL}/signup?ref=${encodeURIComponent(code)}`;

  const handleCopy = async () => {
    beaconShareClick('win_copy');
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy and share:', shareText);
    }
  };

  const handleShare = async () => {
    beaconShareClick('win_native');
    try {
      await navigator.share({ title: 'BinGo Auctions', text: shareText });
    } catch {
      // Sheet dismissed — fine.
    }
  };

  return (
    <section
      style={{
        marginTop: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'rgba(34,197,94,0.06)',
        border: '1px solid rgba(34,197,94,0.35)',
        borderRadius: 10,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '1rem',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <div style={{ fontWeight: 800 }}>Scored a deal? Tell somebody. 🎉</div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>
          Share your win with your code <strong style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>{code}</strong>{' '}
          — when a friend signs up and picks up their first win, you both get $5 off.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={handleCopy} className="btn-secondary" style={{ padding: '0.55rem 1.1rem', fontSize: 13, cursor: 'pointer' }}>
          {copied ? '✓ Copied!' : 'Copy brag'}
        </button>
        {canNativeShare && (
          <button type="button" onClick={handleShare} className="btn-primary" style={{ padding: '0.55rem 1.1rem', fontSize: 13, cursor: 'pointer' }}>
            Share…
          </button>
        )}
      </div>
    </section>
  );
}
