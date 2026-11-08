'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import { relistLot } from './actions';

const DEFAULT_RELIST_TZ = 'America/Chicago';

/** Format an auction end date in the warehouse's IANA timezone. Used for the
 *  relist dropdown option labels so the operator sees wall-clock dates, not
 *  the Cloudflare Workers SSR runtime UTC. */
function fmtEndsAt(iso: string, tz: string | null | undefined): string {
  const resolvedTz = tz && tz.length > 0 ? tz : DEFAULT_RELIST_TZ;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: resolvedTz,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: DEFAULT_RELIST_TZ,
    }).format(new Date(iso));
  }
}

export function RelistButton({
  lotId,
  lotCode,
  auctions,
  warehouseTimezone,
}: {
  lotId: string;
  // L3: the source lot's current code, surfaced so the operator knows the
  // relist mints a NEW code and isn't surprised by the new sticker number.
  lotCode?: string;
  auctions: Array<{ id: string; title: string; ends_at: string; warehouse_id: string }>;
  /** IANA timezone of the warehouse — all auctions in this dropdown are at the
   *  same warehouse, so one tz applies to all option labels. */
  warehouseTimezone?: string | null;
}) {
  const router = useRouter();
  const [target, setTarget] = useState(auctions[0]?.id ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // L3: hold the freshly-minted code so we can confirm it before navigating.
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  if (auctions.length === 0) {
    return (
      <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
        No upcoming auctions at this warehouse. Create one first.
      </p>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 6, marginTop: '0.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          style={{ ...inputStyle, minWidth: 280 }}
        >
          {auctions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} ({fmtEndsAt(a.ends_at, warehouseTimezone)})
            </option>
          ))}
        </select>
        <button
          onClick={async () => {
            setError(null);
            setCreatedCode(null);
            setLoading(true);
            const result = await relistLot({ lotId, targetAuctionId: target });
            setLoading(false);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            // L3: confirm the new code before bouncing to the target auction.
            if (result.newLotCode) setCreatedCode(result.newLotCode);
            router.push(`/auctions/${target}`);
            router.refresh();
          }}
          disabled={loading || !target}
          style={buttonStyle}
          title={
            lotCode
              ? `Relisting always mints a NEW lot code (current: ${lotCode}).`
              : 'Relisting always mints a new lot code.'
          }
        >
          {loading ? 'Relisting…' : 'Relist'}
        </button>
        {error && (
          <span style={{ color: 'var(--danger)', fontSize: 13, ...secondaryButtonStyle }}>{error}</span>
        )}
      </div>
      {/* L3: always-new-code label (no behavior change — the relist RPC keeps
          minting a fresh lot_code; this just stops the new number being a
          surprise). */}
      <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        {createdCode ? (
          <>
            Created{' '}
            <span style={{ fontFamily: 'monospace', color: 'var(--success, #4ade80)' }}>
              {createdCode}
            </span>
            {lotCode ? (
              <>
                {' '}(was <span style={{ fontFamily: 'monospace' }}>{lotCode}</span>)
              </>
            ) : null}
            .
          </>
        ) : (
          <>
            Relisting keeps the item but mints a new lot code
            {lotCode ? (
              <>
                {' '}(was <span style={{ fontFamily: 'monospace' }}>{lotCode}</span>)
              </>
            ) : null}
            .
          </>
        )}
      </span>
    </div>
  );
}
