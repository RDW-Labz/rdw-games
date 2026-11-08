import { formatCount } from '@/app/(operator)/dashboard/v2/floor-story';

export type AuctionLotSummaryProps = {
  activeStatus: 'scheduled' | 'live';
  totalLots: number;
  activeLots: number;
  wonLots: number;
  unsoldLots: number;
  totalBids: number;
  noBidLots: number;
  newlyAddedLots: number;
  carriedOverLots: number;
  forfeitedReturnLots: number;
};

type SummaryTileConfig = {
  id: string;
  label: string;
  value: number;
  definition: string;
};

export function AuctionDetailLotSummary({
  activeStatus,
  totalLots,
  activeLots,
  wonLots,
  unsoldLots,
  totalBids,
  noBidLots,
  newlyAddedLots,
  carriedOverLots,
  forfeitedReturnLots,
}: AuctionLotSummaryProps) {
  const tiles: SummaryTileConfig[] = [
    { id: 'total', label: 'Total lots', value: totalLots, definition: 'all lots in this auction' },
    {
      id: 'active',
      label: activeStatus === 'live' ? 'Live now' : 'Opening',
      value: activeLots,
      definition:
        activeStatus === 'live' ? 'status = live' : 'status = scheduled (not yet open)',
    },
    { id: 'won', label: 'Won', value: wonLots, definition: 'status = won' },
    { id: 'unsold', label: 'Unsold', value: unsoldLots, definition: 'status = unsold' },
    { id: 'bids', label: 'Total bids', value: totalBids, definition: 'sum across all lots' },
    {
      id: 'no-bid',
      label: 'No-bid lots',
      value: noBidLots,
      definition: 'open with 0 bids — needs push',
    },
  ];

  return (
    <>
      <section
        className="console-v2-auction-detail-stats console-v2-motion-reveal"
        aria-label="Lot and bid summary"
      >
        <div className="console-v2-auction-detail-stats-grid" role="list">
          {tiles.map((tile, index) => (
            <div
              key={tile.id}
              className="console-v2-stat-tile console-v2-motion-reveal"
              style={{ animationDelay: `${index * 40}ms` }}
              role="listitem"
            >
              <div className="console-v2-stat-tile__label">{tile.label}</div>
              <div className="console-v2-stat-tile__value console-v2-display">{formatCount(tile.value)}</div>
              <p className="console-v2-stat-tile__def">{tile.definition}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="console-v2-auction-detail-provenance console-v2-motion-reveal">
        <span className="console-v2-auction-detail-provenance-heading">
          {`Provenance of ${totalLots} lot${totalLots === 1 ? '' : 's'}:`}
        </span>
        <ProvenanceItem label="Newly-added" value={newlyAddedLots} hint="first-time lots" />
        <ProvenanceItem
          label="Carried-over"
          value={carriedOverLots}
          hint="relisted from a prior auction"
        />
        <ProvenanceItem
          label="Forfeited-return"
          value={forfeitedReturnLots}
          hint="bidder no-showed / forfeited pickup"
        />
      </div>
    </>
  );
}

function ProvenanceItem({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <span className="console-v2-auction-detail-provenance-item">
      <strong>{label}</strong>
      <span className="console-v2-auction-detail-provenance-count">{formatCount(value)}</span>
      <span className="console-v2-auction-detail-provenance-hint">({hint})</span>
    </span>
  );
}
