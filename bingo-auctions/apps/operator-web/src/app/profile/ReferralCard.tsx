'use client';

// "Give $5, get $5" card on the bidder profile (mig 0229). Shows the
// bidder's shareable code + current credit balance, with copy/share
// actions. The share link lands on /signup?ref=CODE; SignupFormClient
// stashes the code through the email-confirmation round-trip.

import { useEffect, useState } from 'react';
import { beaconShareClick } from '../(public)/_components/ShareBar';

const APP_URL = 'https://bingoauctions.com';

export function ReferralCard({
  code,
  balanceCents,
}: {
  code: string;
  balanceCents: number;
}) {
  const [copied, setCopied] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);

  useEffect(() => {
    setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  const shareUrl = `${APP_URL}/signup?ref=${encodeURIComponent(code)}`;
  const shareText = `Join me on BinGo Auctions — use my code ${code} and we both get $5 off. ${shareUrl}`;

  const handleCopy = async () => {
    beaconShareClick('referral_copy');
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy your referral link:', shareText);
    }
  };

  const handleShare = async () => {
    beaconShareClick('referral_native');
    try {
      await navigator.share({ title: 'BinGo Auctions', text: shareText });
    } catch {
      // Sheet dismissed — fine.
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '1rem',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <div style={{ fontWeight: 700 }}>
          Your code:{' '}
          <span
            style={{
              fontFamily: 'monospace',
              fontSize: 16,
              color: 'var(--accent)',
              letterSpacing: 2,
            }}
          >
            {code}
          </span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>
          Friend signs up with it, pays for and picks up their first win — you each get $5 off.
          {balanceCents > 0 && (
            <>
              {' '}
              Current credit: <strong style={{ color: 'var(--accent)' }}>${(balanceCents / 100).toFixed(2)}</strong>{' '}
              (applies to your next invoice automatically).
            </>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={handleCopy} className="btn-secondary" style={{ padding: '0.55rem 1.1rem', fontSize: 13, cursor: 'pointer' }}>
          {copied ? '✓ Copied!' : 'Copy invite'}
        </button>
        {canNativeShare && (
          <button type="button" onClick={handleShare} className="btn-primary" style={{ padding: '0.55rem 1.1rem', fontSize: 13, cursor: 'pointer' }}>
            Share…
          </button>
        )}
      </div>
    </div>
  );
}
