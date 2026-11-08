'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { relistWorklistLot, pullLotToInventory, disposeWorklistLot } from './actions';

export type WorklistAuctionOption = {
  id: string;
  title: string;
  warehouse_id: string;
  ends_at: string;
};

// Inline per-row actions for the Worklist (M9). Reuses the canonical relist
// RPC + mark_lot_disposed via the worklist server actions. Rendered only for
// admin/manager (canAct). Relist targets are filtered to the lot's warehouse
// because relist_lot_into_auction enforces same-warehouse.
export function WorklistRowActions({
  lotId,
  lotCode,
  warehouseId,
  auctions,
  canAct,
}: {
  lotId: string;
  lotCode: string;
  warehouseId: string | null;
  auctions: WorklistAuctionOption[];
  canAct: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDispose, setConfirmingDispose] = useState(false);

  // Only auctions at this lot's warehouse are valid relist targets.
  const eligibleAuctions = useMemo(
    () => auctions.filter((a) => warehouseId != null && a.warehouse_id === warehouseId),
    [auctions, warehouseId],
  );
  const [target, setTarget] = useState(eligibleAuctions[0]?.id ?? '');

  if (!canAct) {
    return (
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
        Admin / manager only
      </span>
    );
  }

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? 'Action failed');
        return;
      }
      onOk?.();
      router.refresh();
    });
  };

  const cellStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    alignItems: 'stretch',
    minWidth: 220,
  };
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    flexWrap: 'wrap',
  };
  const btn: React.CSSProperties = {
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 700,
    borderRadius: 4,
    cursor: pending ? 'default' : 'pointer',
    border: '1px solid var(--border)',
    background: 'var(--bg-elev)',
    color: 'var(--fg)',
    whiteSpace: 'nowrap',
  };
  const primaryBtn: React.CSSProperties = {
    ...btn,
    background: 'var(--accent-dim)',
    color: 'var(--accent)',
    borderColor: 'var(--accent)',
  };
  const dangerBtn: React.CSSProperties = {
    ...btn,
    background: 'transparent',
    color: 'var(--danger, #f87171)',
    borderColor: 'var(--danger, #f87171)',
  };

  return (
    <div style={cellStyle}>
      {/* Relist into [auction ▾] */}
      {eligibleAuctions.length > 0 ? (
        <div style={rowStyle}>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={pending}
            aria-label="Relist into auction"
            style={{
              flex: 1,
              minWidth: 120,
              padding: '4px 8px',
              fontSize: 12,
              borderRadius: 4,
              background: 'var(--bg-elev)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
            }}
          >
            {eligibleAuctions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending || !target}
            style={primaryBtn}
            onClick={() =>
              run(
                () => relistWorklistLot({ lotId, targetAuctionId: target }),
                () => {
                  // L3: surface the freshly-minted code so the new sticker
                  // number isn't a surprise.
                  setNotice(`Relisting mints a new code (was ${lotCode}).`);
                },
              )
            }
            title={`Relisting always mints a NEW lot code (current: ${lotCode}). The new code is shown after relist.`}
          >
            {pending ? 'Relisting…' : 'Relist'}
          </button>
        </div>
      ) : (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {warehouseId
            ? 'No upcoming auction at this warehouse'
            : 'No warehouse — pull to inventory first'}
        </span>
      )}

      <div style={rowStyle}>
        <button
          type="button"
          disabled={pending}
          style={btn}
          onClick={() => run(() => pullLotToInventory({ lotId }))}
          title="Move this lot back to In-inventory so it leaves the worklist."
        >
          Pull to inventory
        </button>

        {confirmingDispose ? (
          <>
            <button
              type="button"
              disabled={pending}
              style={dangerBtn}
              onClick={() =>
                run(
                  () => disposeWorklistLot({ lotId, reason: null }),
                  () => setConfirmingDispose(false),
                )
              }
            >
              {pending ? 'Disposing…' : 'Confirm dispose'}
            </button>
            <button
              type="button"
              disabled={pending}
              style={btn}
              onClick={() => setConfirmingDispose(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={pending}
            style={dangerBtn}
            onClick={() => setConfirmingDispose(true)}
            title="Mark this lot disposed (status=disposed). Admin/manager only."
          >
            Dispose
          </button>
        )}
      </div>

      {/* L3: relist label — always-new code reminder. */}
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
        Relisting keeps the item but mints a new lot code (was{' '}
        <span style={{ fontFamily: 'monospace' }}>{lotCode}</span>).
      </span>

      {notice && (
        <span style={{ fontSize: 11, color: 'var(--success, #4ade80)' }}>{notice}</span>
      )}
      {error && (
        <span style={{ fontSize: 11, color: 'var(--danger, #f87171)' }}>{error}</span>
      )}
    </div>
  );
}
