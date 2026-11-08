'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteDraftLot } from './actions';
import { lotDisplayCode } from '@auction-platform/shared';
import { DataTable, MoneyText, MonoText, type Column } from '@/components/console';

type LotRow = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  title: string;
  source: string | null;
  msrp_cents: number | null;
  photo_urls: string[] | null;
  created_at: string;
};

export function DraftsTable({
  canEdit,
  lots,
}: {
  canEdit: boolean;
  lots: LotRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onDelete(lotId: string, lotCode: string) {
    if (!canEdit) return;
    const confirmed = window.confirm(
      `Delete draft ${lotCode}? The thermal label is no longer valid — discard it.`,
    );
    if (!confirmed) return;
    setError(null);
    startTransition(async () => {
      const r = await deleteDraftLot({ lot_id: lotId });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  const columns: Column<LotRow>[] = [
    {
      key: 'lot_code',
      header: 'Lot code',
      width: 120,
      cell: (lot) => (
        <Link
          href={`/lots/${lot.id}`}
          style={{
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 13,
            color: 'var(--accent)',
            fontWeight: 700,
            textDecoration: 'none',
          }}
        >
          {lotDisplayCode(lot) ?? lot.lot_code}
        </Link>
      ),
    },
    {
      key: 'title',
      header: 'Title',
      cell: (lot) => (
        <span
          style={{ display: 'block', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={lot.title}
        >
          {lot.title}
        </span>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      width: 160,
      cell: (lot) => (
        <span
          style={{ display: 'block', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-muted)', fontSize: 12 }}
          title={lot.source ?? 'Manual'}
        >
          {lot.source ?? 'Manual'}
        </span>
      ),
    },
    {
      key: 'msrp',
      header: 'MSRP',
      numeric: true,
      cell: (lot) => (lot.msrp_cents != null ? <MoneyText cents={lot.msrp_cents} /> : '—'),
    },
    {
      key: 'lotted',
      header: 'Lotted',
      width: 140,
      cell: (lot) => (
        <MonoText dim style={{ fontSize: 12 }}>
          {new Date(lot.created_at).toLocaleDateString()}
        </MonoText>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      align: 'right',
      width: 110,
      cell: (lot) =>
        canEdit ? (
          <button
            type="button"
            onClick={() => onDelete(lot.id, lotDisplayCode(lot) ?? lot.lot_code)}
            disabled={pending}
            style={{
              padding: '4px 10px',
              background: 'transparent',
              color: 'var(--danger)',
              border: '1px solid var(--danger)',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 700,
              cursor: pending ? 'not-allowed' : 'pointer',
              opacity: pending ? 0.5 : 1,
            }}
          >
            Delete
          </button>
        ) : null,
    },
  ];

  return (
    <>
      {error && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            color: 'var(--danger)',
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid var(--danger)',
            borderRadius: 4,
            fontSize: 13,
            maxWidth: 720,
          }}
        >
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={lots}
        rowKey={(lot) => lot.id}
        empty="No draft lots."
        style={{ maxWidth: 1200 }}
      />
    </>
  );
}
