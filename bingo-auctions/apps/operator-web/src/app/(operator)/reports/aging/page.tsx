// Aging inventory — items that have cycled through N+ auctions without selling
// (Jared patch notes 2026-07-24 #3). An item relisted twice (relist_count 2 =
// Jared's "_02") has been offered in 3 auctions; if it still hasn't sold it
// should leave the normal rotation. The cycle threshold is configurable via
// ?cycles=N (default 3). Data via aging_inventory_report() (mig 0286) — one
// operator-scoped SECURITY DEFINER RPC that resolves each item's lineage root
// (original code) and current (tip) lot.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { locationComparator } from '@/lib/location-sort';
import { AgingInventoryTable, type AgingRow } from './AgingInventoryTable';

// Rows are sorted per warehouse, then by bin location (aisle/bay/shelf,
// numeric-aware — "2" before "10"), lots with no bin last. Same order the
// table renders, prints, and would export (no CSV export exists for this
// report today). See apps/operator-web/src/lib/location-sort.ts.
const agingLocationComparator = locationComparator<AgingRow>((r) => ({
  warehouseName: r.warehouseName,
  locationCode: r.binCode,
  tieBreak: r.currentDisplayCode ?? r.currentLotCode,
}));

export const dynamic = 'force-dynamic';

const MIN_CYCLES = 2;
const MAX_CYCLES = 10;
const DEFAULT_CYCLES = 3;

function parseCycles(raw: string | undefined): number {
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_CYCLES;
  return Math.min(MAX_CYCLES, Math.max(MIN_CYCLES, Math.trunc(n)));
}

type Rpc = {
  lot_id: string;
  // mig 0320: the sticker leads. cycle_code is "BRN4374029_03" — the label
  // physically on the box plus the derived cycle number.
  cycle_code: string;
  current_display_code: string | null;
  original_display_code: string | null;
  current_lot_code: string;
  original_lot_code: string | null;
  auction_cycles: number;
  status: string;
  flagged_for_disposal: boolean;
  auction_id: string | null;
  auction_title: string | null;
  bin_code: string | null;
  warehouse_name: string | null;
  msrp_cents: number | null;
  last_relisted_at: string | null;
};

export default async function AgingInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ cycles?: string }>;
}) {
  const sp = await searchParams;
  const cycles = parseCycles(sp.cycles);

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const { data, error } = await supabase.rpc('aging_inventory_report', {
    p_min_cycles: cycles,
  });
  const rows: AgingRow[] = ((data as Rpc[] | null) ?? [])
    .filter(Boolean)
    .map((r) => ({
      lotId: r.lot_id,
      cycleCode: r.cycle_code,
      currentDisplayCode: r.current_display_code,
      originalDisplayCode: r.original_display_code,
      currentLotCode: r.current_lot_code,
      originalLotCode: r.original_lot_code,
      cycles: r.auction_cycles,
      status: r.status,
      flagged: r.flagged_for_disposal,
      auctionId: r.auction_id,
      auctionTitle: r.auction_title,
      binCode: r.bin_code,
      warehouseName: r.warehouse_name,
      msrpCents: r.msrp_cents,
    }))
    .sort(agingLocationComparator);

  return (
    <div>
      <PageHeader title="Aging inventory" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 780 }}>
        Items that have been offered in <strong>{cycles} or more auctions</strong> without selling.
        Each row is identified by the <strong>sticker physically on the box</strong> — the same
        TEA/PNK/BRN/GRA label it has worn since intake — with the cycle number appended, so{' '}
        <code>BRN4374029_03</code> is that box on its third auction. The sticker never changes; the
        suffix counts the cycles. The small grey code underneath is the internal BIN row, kept only
        for support lookups. Use <em>Remove from cycle</em> to pull an item for disposal, donation,
        or liquidation.
      </p>

      {/* Configurable threshold — Jared asked for this to be adjustable in case
          the allowed number of auction attempts changes. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Flag at
        </span>
        {[2, 3, 4, 5, 6].map((n) => (
          <Link
            key={n}
            href={`/reports/aging?cycles=${n}`}
            aria-current={n === cycles ? 'page' : undefined}
            style={{
              padding: '4px 12px',
              borderRadius: 999,
              border: '1px solid',
              borderColor: n === cycles ? 'var(--accent)' : 'var(--border)',
              background: n === cycles ? 'var(--accent-dim)' : 'transparent',
              color: n === cycles ? 'var(--accent)' : 'var(--fg-muted)',
              fontSize: 12,
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            {n}+ cycles
          </Link>
        ))}
      </div>

      {error && (
        <div
          style={{
            padding: '1rem',
            border: '1px solid rgba(255,84,112,0.4)',
            background: 'rgba(255,84,112,0.08)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 14,
            marginBottom: '1rem',
          }}
        >
          Couldn&apos;t load aging inventory: {error.message}
          {/* Deliberately no guess at the cause. The previous copy asserted
              "migration 0286 may not be applied yet", which sent the 2026-08-13
              report down the wrong path — 0286 was applied; the real fault was a
              msrp_cents INT/BIGINT mismatch inside the function (fixed by 0318,
              carried forward by 0320's DROP+CREATE).
              A wrong hypothesis printed with authority costs more than none. */}
        </div>
      )}

      <AgingInventoryTable rows={rows} />
    </div>
  );
}
