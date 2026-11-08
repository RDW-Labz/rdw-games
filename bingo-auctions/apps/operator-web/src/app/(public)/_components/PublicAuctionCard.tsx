import Link from 'next/link';
import { formatDateInTimeZone, warehouseTimezone, DEFAULT_TIME_ZONE } from '@/lib/datetime';
import { publicAuctionState } from '@/lib/auction-status';

export type PublicAuctionCardRow = {
  id: string;
  title: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  last_lot_ends_at: string | null;
  featured_image_urls: string[] | null;
  lot_count: number;
  warehouses: { timezone: string | null }[] | null;
};

type AuctionClockRow = { status: string; starts_at: string | null };

function isAuctionLive(a: AuctionClockRow, nowMs: number = Date.now()): boolean {
  if (a.status === 'closed') return false;
  if (publicAuctionState(a, nowMs) === 'live') return true;
  const start = a.starts_at ? new Date(a.starts_at).getTime() : null;
  return start !== null && start <= nowMs;
}

export function PublicAuctionCard({ auction }: { auction: PublicAuctionCardRow }) {
  const cover = auction.featured_image_urls?.[0];
  const closeTime = auction.last_lot_ends_at ?? auction.ends_at;
  const isClosed = auction.status === 'closed';
  const isLive = !isClosed && isAuctionLive(auction);

  return (
    <Link
      href={`/auction/${auction.id}`}
      style={{
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
        textDecoration: 'none',
        color: 'inherit',
        display: 'block',
        transition: 'transform 0.15s ease, border-color 0.15s ease',
      }}
    >
      <div
        style={{
          background: 'var(--bg-elev)',
          aspectRatio: '16 / 9',
          width: '100%',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {cover ? (
          <img
            src={cover}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--fg-dim)',
              fontSize: 13,
            }}
          >
            No cover
          </div>
        )}
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            background: isLive
              ? 'rgba(34,197,94,0.95)'
              : isClosed
                ? 'rgba(99,102,116,0.92)'
                : 'rgba(10,12,17,0.85)',
            color: isLive || isClosed ? '#fff' : 'var(--fg)',
            padding: '0.25rem 0.6rem',
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 1.5,
          }}
        >
          {isLive ? 'Live' : isClosed ? 'Results' : 'Upcoming'}
        </div>
      </div>

      <div style={{ padding: '1rem 1.1rem 1.1rem' }}>
        <div
          style={{
            fontWeight: 700,
            fontSize: '1rem',
            lineHeight: 1.3,
            marginBottom: 6,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {auction.title}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 12,
            color: 'var(--fg-muted)',
          }}
        >
          <span>
            {auction.lot_count} lot{auction.lot_count === 1 ? '' : 's'}
          </span>
          {closeTime && (
            <span>
              {isLive ? 'Ends ' : 'Opens '}
              {formatDateInTimeZone(
                isLive ? closeTime : auction.starts_at ?? closeTime,
                warehouseTimezone(auction.warehouses) ?? DEFAULT_TIME_ZONE,
              )}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
