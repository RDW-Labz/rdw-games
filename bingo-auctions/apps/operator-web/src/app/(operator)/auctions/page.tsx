import Link from 'next/link';
import { cookies } from 'next/headers';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatInTimeZone, warehouseTimezone, DEFAULT_TIME_ZONE } from '@/lib/datetime';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { isWarehouseOffSite } from '@/components/console-v2/off-site';
import { PageHeader, buttonStyle, secondaryButtonStyle } from '@/components/Form';
import { StatusPill, DataTable, type Column } from '@/components/console';
import {
  auctionListHref,
  pageRange,
  parseAuctionListParams,
  titleIlikePattern,
  type AuctionStatusTab,
} from '@/lib/auction-list-query';
import { AuctionListControls } from './AuctionListControls';
import { CloneAuctionButton } from './CloneAuctionButton';
import { AuctionsV2 } from './v2/AuctionsV2';
import type { AuctionListV2Row } from './v2/auction-list-types';

const AUCTION_LIST_SELECT =
  'id, title, status, starts_at, ends_at, buyer_premium_bps, warehouse_id, featured_image_urls, warehouses(timezone)';

const STATUS_TABS: AuctionStatusTab[] = [
  'all',
  'draft',
  'scheduled',
  'live',
  'closed',
  'canceled',
];

// Row shape for the auctions list table. `warehouses` is the embedded
// relation used only to resolve the per-row timezone.
type AuctionRow = {
  id: string;
  title: string;
  status: string;
  starts_at: string;
  ends_at: string;
  buyer_premium_bps: number;
  featured_image_urls: string[] | null;
  warehouses: unknown;
};

export default async function AuctionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const listParams = parseAuctionListParams(await searchParams);
  const { q, status, page } = listParams;

  const supabase = await getSupabaseServer();
  // Resolve the caller's operator and scope the list to it. Don't
  // rely on RLS alone here: staff who ALSO have a bidders row satisfy
  // both auctions_staff_read AND auctions_bidder_read_published, which
  // leaks every operator's scheduled/live/closed auctions into the
  // list. Filtering by operator_id at the app layer keeps the operator
  // console showing only the current operator's auctions — and stops
  // the "Add from inventory" link on a foreign auction from 404'ing
  // the builder query (the builder query IS operator-scoped, so the
  // mismatch surfaces as notFound()).
  const { data: { user } } = await supabase.auth.getUser();
  let operatorId: string | null = null;
  if (user) {
    const { data: me } = await supabase
      .from('operator_users')
      .select('operator_id')
      .eq('user_id', user.id)
      .single();
    operatorId = (me?.operator_id as string | null) ?? null;
  }

  const titlePattern = titleIlikePattern(q);
  const [rangeFrom, rangeTo] = pageRange(page);

  const countForStatusTab = async (tab: AuctionStatusTab): Promise<number> => {
    let cq = supabase.from('auctions').select('id', { count: 'exact', head: true });
    if (operatorId) cq = cq.eq('operator_id', operatorId);
    if (titlePattern) cq = cq.ilike('title', titlePattern);
    if (tab !== 'all') cq = cq.eq('status', tab);
    const { count } = await cq;
    return count ?? 0;
  };

  let listQ = supabase
    .from('auctions')
    // warehouses(timezone) embeds each row's warehouse IANA zone so the
    // Starts/Ends columns render in that auction's local time (each auction
    // can belong to a different warehouse with its own zone).
    .select(AUCTION_LIST_SELECT, { count: 'exact' });
  if (operatorId) listQ = listQ.eq('operator_id', operatorId);
  if (titlePattern) listQ = listQ.ilike('title', titlePattern);
  if (status !== 'all') listQ = listQ.eq('status', status);
  listQ = listQ
    .order('starts_at', { ascending: false })
    .order('id', { ascending: true })
    .range(rangeFrom, rangeTo);

  const [{ data: auctions, count: listTotal }, ...tabCounts] = await Promise.all([
    listQ,
    ...STATUS_TABS.map((tab) => countForStatusTab(tab)),
  ]);
  const rows = (auctions ?? []) as unknown as AuctionRow[];
  const total = listTotal ?? 0;
  const counts = Object.fromEntries(
    STATUS_TABS.map((tab, i) => [tab, tabCounts[i]]),
  ) as Record<AuctionStatusTab, number>;

  const listControls = (
    <AuctionListControls q={q} status={status} page={page} total={total} counts={counts} />
  );

  const searchEmptyMessage = (
    <>
      No auctions match &ldquo;{q}&rdquo;.{' '}
      <Link href={auctionListHref({ q: '', status, page: 1 })}>Clear</Link>
    </>
  );
  const defaultEmptyMessage = (
    <>
      No auctions yet. <Link href="/auctions/new">Create one</Link>.
    </>
  );
  const tableEmpty =
    q && rows.length === 0
      ? searchEmptyMessage
      : status !== 'all'
        ? <>No {status} auctions.</>
        : defaultEmptyMessage;

  const columns: Column<AuctionRow>[] = [
    {
      key: 'title',
      header: 'Title',
      cell: (a) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FeaturedThumbStrip urls={a.featured_image_urls ?? []} />
          <Link href={`/auctions/${a.id}`}>{a.title}</Link>
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (a) => <StatusPill status={a.status} /> },
    {
      key: 'starts',
      header: 'Starts',
      cell: (a) => formatInTimeZone(a.starts_at, warehouseTimezone(a.warehouses) ?? DEFAULT_TIME_ZONE),
    },
    {
      key: 'ends',
      header: 'Ends',
      cell: (a) => formatInTimeZone(a.ends_at, warehouseTimezone(a.warehouses) ?? DEFAULT_TIME_ZONE),
    },
    {
      key: 'premium',
      header: 'Premium',
      numeric: true,
      cell: (a) => `${(a.buyer_premium_bps / 100).toFixed(1)}%`,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (a) => <CloneAuctionButton auctionId={a.id} />,
    },
  ];

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    const auctionIds = rows.map((a) => a.id);
    const lotCountByAuction = new Map<string, number>();
    const lastCloseByAuction = new Map<string, string | null>();
    const warehouseById = new Map<
      string,
      { name: string; offSite: boolean; timezone: string | null }
    >();

    if (auctionIds.length > 0) {
      const { data: enriched } = await supabase
        .from('auctions')
        .select('id, ends_at, last_lot_ends_at, warehouse_id, warehouses(*)')
        .in('id', auctionIds);
      for (const row of enriched ?? []) {
        const r = row as {
          id: string;
          ends_at: string;
          last_lot_ends_at: string | null;
          warehouse_id: string | null;
          warehouses: unknown;
        };
        lastCloseByAuction.set(r.id, r.last_lot_ends_at);
        const whRaw = r.warehouses;
        const wh = (Array.isArray(whRaw) ? whRaw[0] : whRaw) as Record<string, unknown> | null;
        if (r.warehouse_id && wh) {
          warehouseById.set(r.warehouse_id, {
            name: String(wh.name ?? 'Warehouse'),
            offSite: isWarehouseOffSite(wh as { customer_notice?: string | null }),
            timezone: (wh.timezone as string | null) ?? null,
          });
        }
      }

      const { data: lotRows } = await supabase
        .from('lots')
        .select('auction_id')
        .in('auction_id', auctionIds)
        .is('deleted_at', null);
      for (const lot of lotRows ?? []) {
        const aid = (lot as { auction_id: string }).auction_id;
        lotCountByAuction.set(aid, (lotCountByAuction.get(aid) ?? 0) + 1);
      }
    }

    const v2Rows: AuctionListV2Row[] = rows.map((a) => {
      const whEmbed = a.warehouses;
      const tz =
        warehouseTimezone(whEmbed) ??
        warehouseById.get(
          (a as { warehouse_id?: string }).warehouse_id ?? '',
        )?.timezone ??
        DEFAULT_TIME_ZONE;
      const whId = (a as { warehouse_id?: string }).warehouse_id;
      const whMeta = whId ? warehouseById.get(whId) : undefined;
      const firstClose = a.ends_at;
      const lastClose = lastCloseByAuction.get(a.id) ?? a.ends_at;
      return {
        id: a.id,
        title: a.title,
        status: a.status,
        startsAtLabel: formatInTimeZone(a.starts_at, tz),
        firstCloseLabel: formatInTimeZone(firstClose, tz),
        lastCloseLabel: formatInTimeZone(lastClose, tz),
        lotCount: lotCountByAuction.get(a.id) ?? 0,
        warehouseName: whMeta?.name ?? '—',
        offSite: whMeta?.offSite ?? false,
        featuredImageUrls: (a.featured_image_urls ?? []).slice(0, 3),
        premiumLabel: `${(a.buyer_premium_bps / 100).toFixed(1)}%`,
      };
    });

    if (q && rows.length === 0) {
      return (
        <>
          {listControls}
          <p className="console-v2-auctions-empty console-v2-motion-reveal">
            No auctions match &ldquo;{q}&rdquo;.{' '}
            <Link href={auctionListHref({ q: '', status, page: 1 })} className="console-v2-code">
              Clear
            </Link>
            .
          </p>
        </>
      );
    }

    return (
      <>
        {listControls}
        <AuctionsV2 rows={v2Rows} />
      </>
    );
  }

  return (
    <div>
      <PageHeader
        title="Auctions"
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <Link
              href="/auctions/auto-build"
              style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
            >
              Auto-build
            </Link>
            <Link href="/auctions/new" style={{ ...buttonStyle, textDecoration: 'none' }}>
              New auction
            </Link>
          </div>
        }
      />
      {listControls}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        empty={tableEmpty}
      />
    </div>
  );
}

// Compact 3-tile thumbnail strip for the auction list table. Renders the
// first 3 of the auction's featured_image_urls. Empty box when none —
// keeps the row height stable so the table doesn't jump as auctions get
// curated. Mirrors what bidder-facing list cards will look like.
function FeaturedThumbStrip({ urls }: { urls: string[] }) {
  const safe = urls.slice(0, 3);
  if (safe.length === 0) {
    return (
      <div
        aria-hidden
        style={{
          width: 60,
          height: 40,
          borderRadius: 4,
          background: 'var(--bg-elev)',
          border: '1px dashed var(--border)',
        }}
      />
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        width: 60,
        height: 40,
        flexShrink: 0,
      }}
    >
      {safe.map((u, i) => (
        // plain <img> — opennextjs has known edge cases with <Image> over CF resizing
        <img
          key={`${u}-${i}`}
          src={u}
          alt=""
          loading="lazy"
          style={{
            flex: 1,
            height: '100%',
            objectFit: 'cover',
            borderRadius: 3,
            background: 'var(--bg-elev)',
          }}
        />
      ))}
    </div>
  );
}
