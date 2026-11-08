// /lotting/stickers — print blank QR sticker rolls for Flow B (pre-stickered lotting).
//
// Two halves:
//
//   1. Print form   — operator picks a count + sheet size, hits "Generate PDF",
//                     /api/lots/blank-qr-sheet mints a batch and streams a PDF.
//                     We download via Blob URL so the browser opens the PDF
//                     in a new tab; the operator hits print from there.
//
//   2. Recent batches — server-rendered table aggregated from lot_sticker_pool
//                       (RLS-scoped to the caller's operator). Shows
//                       printed_at, total count, claimed count, unclaimed
//                       count. Useful for "how much of that roll is left?"
//
// The form is the only client component on the page; everything else is
// rendered on the server using the same supabase client pattern as the
// rest of the operator console.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { DataTable, MonoText, type Column } from '@/components/console';
import { BlankStickerForm } from './BlankStickerForm';

export const dynamic = 'force-dynamic';

interface BatchRow {
  printed_batch_id: string;
  printed_at: string;
  total: number;
  claimed: number;
  unclaimed: number;
}

export default async function BlankStickersPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  // Fetch up to 1000 recent pool rows and aggregate client-side. We
  // avoid a custom RPC for the rollup so the page stays simple — the
  // pool table is small (a typical operator prints batches of 50-100,
  // and historical rows that are 100% claimed can be cleaned up later).
  // RLS scopes results to the caller's operator.
  const { data: poolRows, error } = await supabase
    .from('lot_sticker_pool')
    .select('printed_batch_id, printed_at, claimed_at')
    .order('printed_at', { ascending: false })
    .limit(1000);

  let batchRows: BatchRow[] = [];
  if (poolRows && !error) {
    const byBatch = new Map<string, BatchRow>();
    for (const r of poolRows as Array<{
      printed_batch_id: string;
      printed_at: string;
      claimed_at: string | null;
    }>) {
      const existing = byBatch.get(r.printed_batch_id);
      if (existing) {
        existing.total += 1;
        if (r.claimed_at) existing.claimed += 1;
        else existing.unclaimed += 1;
        // Keep earliest printed_at as the batch print time (they're
        // all written in the same transaction so this is moot, but
        // stays correct if a future change loosens that).
        if (r.printed_at < existing.printed_at) existing.printed_at = r.printed_at;
      } else {
        byBatch.set(r.printed_batch_id, {
          printed_batch_id: r.printed_batch_id,
          printed_at: r.printed_at,
          total: 1,
          claimed: r.claimed_at ? 1 : 0,
          unclaimed: r.claimed_at ? 0 : 1,
        });
      }
    }
    batchRows = [...byBatch.values()].sort((a, b) =>
      a.printed_at < b.printed_at ? 1 : -1,
    );
  }

  const batchColumns: Column<BatchRow>[] = [
    {
      key: 'batch',
      header: 'Batch',
      cell: (b) => <MonoText dim>{b.printed_batch_id.slice(0, 8)}…</MonoText>,
    },
    {
      key: 'printed',
      header: 'Printed',
      cell: (b) => {
        const printedDate = new Date(b.printed_at);
        return isNaN(printedDate.getTime())
          ? b.printed_at
          : printedDate.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      },
    },
    { key: 'total', header: 'Total', numeric: true, cell: (b) => b.total },
    {
      key: 'claimed',
      header: 'Claimed',
      numeric: true,
      cell: (b) => (
        <>
          {b.claimed}{' '}
          <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>
            ({b.total > 0 ? Math.round((b.claimed / b.total) * 100) : 0}%)
          </span>
        </>
      ),
    },
    {
      key: 'unclaimed',
      header: 'Unclaimed',
      numeric: true,
      cell: (b) => (
        <span style={{ fontWeight: b.unclaimed > 0 ? 700 : 400, color: b.unclaimed > 0 ? 'var(--fg)' : 'var(--fg-muted)' }}>
          {b.unclaimed}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Print blank QR stickers" />
      <p
        style={{
          color: 'var(--fg-muted)',
          maxWidth: 720,
          lineHeight: 1.5,
          marginBottom: 24,
        }}
      >
        Pre-print a batch of generic stickers. Apply them to physical items
        before or during lotting; scan them in the field-mobile app to
        assign each one to a freshly-lotted item. Use this when you don&apos;t
        want to print a per-lot sticker on-demand (Flow B).
      </p>

      <BlankStickerForm />

      <h2
        style={{
          fontSize: 14,
          color: 'var(--fg-muted)',
          fontWeight: 800,
          letterSpacing: 1,
          textTransform: 'uppercase',
          marginTop: 32,
          marginBottom: 8,
        }}
      >
        Recent batches
      </h2>
      <p
        style={{
          color: 'var(--fg-muted)',
          fontSize: 13,
          marginTop: 0,
          marginBottom: 12,
          maxWidth: 720,
        }}
      >
        Every sticker is tied to a batch. Unclaimed = still on the roll
        waiting to be applied + scanned; claimed = already attached to a
        lot. If a sticker gets lost, leave the row alone — the next roll
        you print mints fresh UUIDs.
      </p>

      <div style={{ maxWidth: 720 }}>
        <DataTable
          columns={batchColumns}
          rows={batchRows}
          rowKey={(b) => b.printed_batch_id}
          empty="No batches yet. Use the form above to print your first roll."
        />
      </div>
    </div>
  );
}

