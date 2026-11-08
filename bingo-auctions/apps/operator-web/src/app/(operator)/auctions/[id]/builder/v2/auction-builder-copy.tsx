// mirrors v1 auctions/[id]/builder/page.tsx intro + notice blocks — keep in sync.
// v2 renders the same copy; v1 keeps its own inline JSX so toggle-off stays byte-identical.
import type { ReactNode } from 'react';

type BuilderBucket = 'available' | 'unsold' | 'unpicked_up';

export function AuctionBuilderIntroV2({
  auctionTitle,
  bucket,
  firstLotNumber,
}: {
  auctionTitle: string;
  bucket: BuilderBucket;
  firstLotNumber: number;
}) {
  const isCarryover = bucket === 'unsold' || bucket === 'unpicked_up';
  return (
    <div
      style={{
        padding: 12,
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--bg-elev)',
        fontSize: 13,
        color: 'var(--fg-muted)',
        lineHeight: 1.5,
      }}
    >
      {isCarryover ? (
        <>
          Carry over {bucket === 'unsold' ? 'unsold' : 'unpicked-up'} lots into{' '}
          <strong style={{ color: 'var(--fg)' }}>{auctionTitle}</strong>. Each carried-over
          lot is <strong style={{ color: 'var(--fg)' }}>relisted</strong> — it gets a brand-new
          lot code and lot number while keeping a link back to the original (its provenance).
          New lot numbers start at <strong style={{ color: 'var(--fg)' }}>#{firstLotNumber}</strong>.
        </>
      ) : (
        <>
          Pick lots from inventory to add to <strong style={{ color: 'var(--fg)' }}>{auctionTitle}</strong>.
          Selected items get sequential lot numbers starting at <strong style={{ color: 'var(--fg)' }}>
            #{firstLotNumber}</strong> and flip to <strong style={{ color: 'var(--fg)' }}>scheduled</strong>.
          Bidders won&apos;t see them until the auction itself is scheduled.
        </>
      )}
    </div>
  );
}

export function buildAuctionBuilderNoticesV2({
  bucket,
  availableOverflow,
  shownCount,
  availableCount,
  otherWarehouseInventoryCount,
  shelvedDraftCount,
  awaitingPutAwayCount,
}: {
  bucket: BuilderBucket;
  availableOverflow: boolean;
  shownCount: number;
  availableCount: number;
  otherWarehouseInventoryCount: number;
  shelvedDraftCount: number;
  awaitingPutAwayCount: number;
}): ReactNode[] {
  const noticeBlocks: ReactNode[] = [];
  if (availableOverflow) {
    noticeBlocks.push(
      <div
        style={{
          padding: 12,
          border: '1px solid var(--console-warning)',
          color: 'var(--console-warning)',
          borderRadius: 8,
          background: 'var(--bg-elev)',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Showing the most recent {shownCount} of {availableCount.toLocaleString()}{' '}
        available lots at this warehouse. Use the search and category filters
        below to find older lots that aren&apos;t shown.
      </div>,
    );
  }
  if (bucket === 'available' && otherWarehouseInventoryCount > 0) {
    noticeBlocks.push(
      <div
        style={{
          padding: 12,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-elev)',
          fontSize: 13,
          color: 'var(--fg-muted)',
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>
          {otherWarehouseInventoryCount.toLocaleString()}
        </strong>{' '}
        in-inventory lot{otherWarehouseInventoryCount === 1 ? ' is' : 's are'} at other
        warehouses and aren&apos;t shown here. Lots can only be added to an
        auction at the same warehouse — switch this auction&apos;s warehouse or
        move the lots to <strong style={{ color: 'var(--fg)' }}>this</strong> warehouse to include
        them.
      </div>,
    );
  }
  if (bucket === 'available' && shelvedDraftCount > 0) {
    noticeBlocks.push(
      <div
        style={{
          padding: 12,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-elev)',
          fontSize: 13,
          color: 'var(--fg-muted)',
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>{shelvedDraftCount.toLocaleString()}</strong>{' '}
        lot{shelvedDraftCount === 1 ? '' : 's'} on a shelf{' '}
        {shelvedDraftCount === 1 ? 'is' : 'are'} still marked{' '}
        <strong style={{ color: 'var(--fg)' }}>draft</strong> — an unfinished
        listing — so {shelvedDraftCount === 1 ? 'it is' : 'they are'} not shown
        here. Open {shelvedDraftCount === 1 ? 'it' : 'them'} from Worklist → Draft and save
        to finish the listing, and {shelvedDraftCount === 1 ? 'it' : 'they'} become available.
      </div>,
    );
  }
  if (bucket === 'available' && awaitingPutAwayCount > 0) {
    noticeBlocks.push(
      <div
        style={{
          padding: 12,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-elev)',
          fontSize: 13,
          color: 'var(--fg-muted)',
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>{awaitingPutAwayCount.toLocaleString()}</strong>{' '}
        lot{awaitingPutAwayCount === 1 ? '' : 's'} exist
        {awaitingPutAwayCount === 1 ? 's' : ''} but{' '}
        {awaitingPutAwayCount === 1 ? 'has' : 'have'} never been scanned onto a
        shelf, so {awaitingPutAwayCount === 1 ? 'it is' : 'they are'} not listed
        here. Duplicated lots start this way on purpose — the copy is a
        different box and has to be put where it actually goes. Work them
        through <strong style={{ color: 'var(--fg)' }}>Put away</strong> in the
        field app (or Worklist → Pending intake) and they become available.
      </div>,
    );
  }
  return noticeBlocks;
}
