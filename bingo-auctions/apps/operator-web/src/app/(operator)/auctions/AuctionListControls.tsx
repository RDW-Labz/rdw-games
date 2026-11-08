import Link from 'next/link';
import {
  AUCTION_PAGE_SIZE,
  auctionListHref,
  type AuctionStatusTab,
} from '@/lib/auction-list-query';

const TAB_LABELS: Record<AuctionStatusTab, string> = {
  all: 'All',
  draft: 'Draft',
  scheduled: 'Scheduled',
  live: 'Live',
  closed: 'Closed',
  canceled: 'Canceled',
};

const STATUS_TABS: AuctionStatusTab[] = [
  'all',
  'draft',
  'scheduled',
  'live',
  'closed',
  'canceled',
];

export type AuctionListControlsProps = {
  q: string;
  status: AuctionStatusTab;
  page: number;
  total: number;
  counts: Record<AuctionStatusTab, number>;
};

export function AuctionListControls({ q, status, page, total, counts }: AuctionListControlsProps) {
  const rangeStart = total === 0 ? 0 : (page - 1) * AUCTION_PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * AUCTION_PAGE_SIZE, total);
  const hasNewer = page > 1;
  const hasOlder = page * AUCTION_PAGE_SIZE < total;

  return (
    <div style={{ marginBottom: 16 }}>
      <form
        action="/auctions"
        method="get"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search auction title…"
          style={{
            flex: '1 1 200px',
            minWidth: 160,
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-elev)',
            color: 'var(--fg)',
            fontSize: 14,
          }}
        />
        {status !== 'all' ? <input type="hidden" name="status" value={status} /> : null}
        <button
          type="submit"
          style={{
            padding: '8px 14px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-elev)',
            color: 'var(--fg)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Search
        </button>
        {q ? (
          <Link
            href={auctionListHref({ q: '', status, page: 1 })}
            style={{ fontSize: 13, color: 'var(--accent)' }}
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        {STATUS_TABS.map((tab) => (
          <StatusFilterPill
            key={tab}
            label={TAB_LABELS[tab]}
            count={counts[tab]}
            href={auctionListHref({ q, status: tab, page: 1 })}
            active={status === tab}
          />
        ))}
      </div>

      {total > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            fontSize: 12,
            color: 'var(--fg-muted)',
          }}
        >
          <span>
            Showing {rangeStart}–{rangeEnd} of {total}
          </span>
          {hasNewer ? (
            <Link
              href={auctionListHref({ q, status, page: page - 1 })}
              style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}
            >
              ← Newer
            </Link>
          ) : null}
          {hasOlder ? (
            <Link
              href={auctionListHref({ q, status, page: page + 1 })}
              style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}
            >
              Older →
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusFilterPill({
  label,
  count,
  href,
  active,
}: {
  label: string;
  count: number;
  href: string;
  active: boolean;
}) {
  const background = active ? 'var(--accent-dim)' : 'var(--bg-elev)';
  const color = active ? 'var(--accent)' : 'var(--fg)';
  const border = active ? '1px solid var(--accent)' : '1px solid var(--border)';

  return (
    <Link
      href={href}
      style={{
        padding: '6px 12px',
        background,
        color,
        border,
        borderRadius: 999,
        textDecoration: 'none',
        fontSize: 12,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
      }}
    >
      <span>{label}</span>
      <span style={{ opacity: 0.75, fontWeight: 600 }}>({count})</span>
    </Link>
  );
}
