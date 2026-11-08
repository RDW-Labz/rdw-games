'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatCents } from '@auction-platform/shared/money';
import { removeFromCycle } from './actions';

export type AgingRow = {
  lotId: string;
  /** "BRN4374029_03" — physical sticker + derived cycle suffix (mig 0320). */
  cycleCode: string;
  /** "BRN4374029" — the label physically on the box today. */
  currentDisplayCode: string | null;
  /** Same label resolved at the lineage root; equal to the above in a healthy
   *  chain, and a mismatch is worth seeing. */
  originalDisplayCode: string | null;
  currentLotCode: string;
  originalLotCode: string | null;
  cycles: number;
  status: string;
  flagged: boolean;
  auctionId: string | null;
  auctionTitle: string | null;
  binCode: string | null;
  warehouseName: string | null;
  msrpCents: number | null;
};

const DISPOSITIONS = [
  { value: 'dispose', label: 'Dispose' },
  { value: 'donate', label: 'Donate' },
  { value: 'liquidate', label: 'Liquidate' },
  { value: 'other', label: 'Other' },
] as const;

// The physical sticker is the item's identity, and it is the ONLY code shown
// (owner, 2026-08-13: "I do not want BIN numbers used for Relot or ageing
// tracking... Customers and staff should continue seeing the physical sticker
// code — not BIN numbers", reaffirmed 2026-08-14).
//
// An earlier revision kept the synthetic BIN-#### as a muted second line, on the
// argument that support needs to join a row here to a specific database row.
// That argument does not survive contact with the page: every row already links
// to /lots/{id}, so clicking it resolves the exact lot without the code ever
// being on screen. The second line bought nothing and put back the number the
// owner asked not to see.
//
// `lotCode` is retained only as a fallback for the impossible case where the
// sticker walk yields nothing — a row with no readable identity at all would be
// worse than a BIN code.
function CodeCell({ label, lotCode }: { label: string | null; lotCode: string | null }) {
  return (
    <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>
      {label ?? lotCode ?? '—'}
    </span>
  );
}

export function AgingInventoryTable({ rows }: { rows: AgingRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [disp, setDisp] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => rows.filter((r) => !removed.has(r.lotId)), [rows, removed]);

  function onRemove(lotId: string) {
    setError(null);
    setBusyId(lotId);
    const disposition = (disp[lotId] ?? 'dispose') as (typeof DISPOSITIONS)[number]['value'];
    startTransition(async () => {
      const res = await removeFromCycle({ lotId, disposition });
      setBusyId(null);
      if (!res.ok) {
        setError(`${lotId.slice(0, 8)}: ${res.error}`);
        return;
      }
      setRemoved((prev) => new Set(prev).add(lotId));
      router.refresh();
    });
  }

  if (visible.length === 0) {
    return (
      <div
        style={{
          padding: 32,
          border: '1px dashed var(--border)',
          borderRadius: 8,
          textAlign: 'center',
          color: 'var(--fg-muted)',
        }}
      >
        No items have reached this many auction cycles. 🎉
      </div>
    );
  }

  const thNum: React.CSSProperties = { textAlign: 'right' };
  const tdNum: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  return (
    <div>
      {error && (
        <div
          style={{
            padding: '0.6rem 0.9rem',
            border: '1px solid rgba(255,84,112,0.4)',
            background: 'rgba(255,84,112,0.08)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 13,
            marginBottom: '0.75rem',
          }}
        >
          {error}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="console-table">
          <thead>
            <tr>
              <th>Item (sticker + cycle)</th>
              <th>Original sticker</th>
              <th style={thNum}>Cycles</th>
              <th>Status</th>
              <th>Location</th>
              <th>Auction</th>
              <th style={thNum}>MSRP</th>
              <th style={{ textAlign: 'right' }}>Remove from cycle</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.lotId}>
                <td>
                  <Link href={`/lots/${r.lotId}`} style={{ textDecoration: 'none' }}>
                    <CodeCell label={r.cycleCode} lotCode={r.currentLotCode} />
                  </Link>
                </td>
                <td>
                  <CodeCell label={r.originalDisplayCode} lotCode={r.originalLotCode} />
                </td>
                <td style={tdNum}>
                  <span
                    style={{
                      display: 'inline-block',
                      minWidth: 22,
                      padding: '1px 8px',
                      borderRadius: 999,
                      fontWeight: 800,
                      fontSize: 12,
                      background: r.cycles >= 4 ? 'rgba(255,84,112,0.15)' : 'var(--bg-elev)',
                      color: r.cycles >= 4 ? 'var(--danger)' : 'var(--fg)',
                    }}
                  >
                    {r.cycles}
                  </span>
                </td>
                <td>
                  <span style={{ fontSize: 12 }}>{r.status}</span>
                  {r.flagged && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10,
                        fontWeight: 800,
                        color: 'var(--danger)',
                        textTransform: 'uppercase',
                      }}
                    >
                      ⚑ flagged
                    </span>
                  )}
                </td>
                <td style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  {r.binCode ?? '—'}
                  {r.warehouseName ? ` · ${r.warehouseName}` : ''}
                </td>
                <td style={{ fontSize: 12 }}>
                  {r.auctionId ? (
                    <Link href={`/auctions/${r.auctionId}`}>{r.auctionTitle ?? 'Auction'}</Link>
                  ) : (
                    <span style={{ color: 'var(--fg-muted)' }}>—</span>
                  )}
                </td>
                <td style={tdNum}>{r.msrpCents != null ? formatCents(r.msrpCents) : '—'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <select
                    aria-label="Disposition"
                    value={disp[r.lotId] ?? 'dispose'}
                    onChange={(e) => setDisp((p) => ({ ...p, [r.lotId]: e.target.value }))}
                    disabled={pending}
                    style={{
                      padding: '4px 8px',
                      background: 'var(--bg-elev)',
                      color: 'var(--fg)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      fontSize: 12,
                      marginRight: 6,
                    }}
                  >
                    {DISPOSITIONS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => onRemove(r.lotId)}
                    disabled={pending}
                    style={{
                      padding: '4px 12px',
                      background: 'transparent',
                      color: 'var(--danger)',
                      border: '1px solid var(--danger)',
                      borderRadius: 6,
                      cursor: pending ? 'not-allowed' : 'pointer',
                      fontSize: 12,
                      fontWeight: 700,
                      opacity: pending && busyId === r.lotId ? 0.5 : 1,
                    }}
                  >
                    {busyId === r.lotId ? 'Removing…' : 'Remove'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
