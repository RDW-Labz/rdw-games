import Link from 'next/link';
import { ConsoleV2Page } from '@/components/console-v2/ConsoleV2Page';
import { SectionHeader } from '@/components/console-v2/SectionHeader';
import { SetupStepper } from '@/components/console-v2/SetupStepper';
import { StatusPill } from '@/components/console-v2/StatusPill';
import { CancelAuctionButton } from '../CancelAuctionButton';
import { ScheduleAuctionButton } from '../ScheduleAuctionButton';
import { AuctionDetailLotSummary } from './AuctionDetailLotSummary';
import { AuctionPreviewQrCard } from './AuctionPreviewQrCard';
import type { AuctionDetailV2Props } from './auction-detail-types';

export function AuctionDetailV2({
  auctionId,
  title,
  status,
  warehouseLabel,
  startsLabel,
  biddingEndsLabel,
  pickupWindowLabel,
  buyerPremiumLabel,
  checklist,
  completedSteps,
  totalApplicableSteps,
  todoSteps,
  canEdit,
  canCancel,
  showSchedule,
  hasLots,
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
  previewQrDataUrl,
  closingWindow,
  featuredCurator,
  lotsTable,
}: AuctionDetailV2Props) {
  const summary = (
    <>
      Status: <strong>{status}</strong>
      {' · '}
      <strong>
        {completedSteps}/{totalApplicableSteps} steps complete
      </strong>
      {todoSteps > 0 ? ` · ${todoSteps} required remaining` : ''}
    </>
  );

  return (
    <ConsoleV2Page className="console-v2-auction-detail">
      <header className="console-v2-auction-detail-head console-v2-motion-reveal">
        <div className="console-v2-auction-detail-headline">
          <h1 className="console-v2-display">{title}</h1>
          <div className="console-v2-auction-detail-badges">
            <StatusPill status={status} />
            <span className="console-v2-auction-detail-warehouse">{warehouseLabel}</span>
          </div>
        </div>
        <dl className="console-v2-auction-detail-dates">
          <div>
            <dt>Starts</dt>
            <dd>{startsLabel}</dd>
          </div>
          <div>
            <dt>Bidding ends</dt>
            <dd>{biddingEndsLabel}</dd>
          </div>
          <div>
            <dt>Pickup window</dt>
            <dd>{pickupWindowLabel}</dd>
          </div>
          <div>
            <dt>Buyer premium</dt>
            <dd>{buyerPremiumLabel}</dd>
          </div>
        </dl>
      </header>

      <section className="console-v2-auction-detail-actions console-v2-motion-reveal" aria-label="Auction actions">
        <SectionHeader title="Actions" stageHue="auction" />
        <div className="console-v2-auction-detail-actions-row">
          {canEdit ? (
            <Link
              href={`/auctions/${auctionId}/builder`}
              className="console-v2-btn console-v2-btn--primary-lime console-v2-pressable"
            >
              + Add from inventory
            </Link>
          ) : null}
          {canEdit ? (
            <Link
              href={`/lots/new?auctionId=${auctionId}`}
              className="console-v2-btn console-v2-btn--secondary console-v2-pressable"
            >
              Add lot manually
            </Link>
          ) : null}
          {canEdit ? (
            <Link
              href={`/auctions/${auctionId}/edit`}
              className="console-v2-btn console-v2-btn--secondary console-v2-pressable"
            >
              Edit
            </Link>
          ) : null}
          {canCancel ? <CancelAuctionButton auctionId={auctionId} /> : null}
          {showSchedule && hasLots ? <ScheduleAuctionButton auctionId={auctionId} /> : null}
        </div>
      </section>

      <AuctionDetailLotSummary
        activeStatus={activeStatus}
        totalLots={totalLots}
        activeLots={activeLots}
        wonLots={wonLots}
        unsoldLots={unsoldLots}
        totalBids={totalBids}
        noBidLots={noBidLots}
        newlyAddedLots={newlyAddedLots}
        carriedOverLots={carriedOverLots}
        forfeitedReturnLots={forfeitedReturnLots}
      />

      <SetupStepper steps={checklist} summary={summary} stageHue="auction" />

      {closingWindow ? (
        <section className="console-v2-auction-detail-window console-v2-motion-reveal">{closingWindow}</section>
      ) : null}

      <section className="console-v2-auction-detail-featured console-v2-motion-reveal">{featuredCurator}</section>

      <AuctionPreviewQrCard
        auctionId={auctionId}
        auctionTitle={title}
        previewQrDataUrl={previewQrDataUrl}
      />

      <section className="console-v2-auction-detail-lots console-v2-motion-reveal">
        <SectionHeader title="Lots" stageHue="auction" />
        {lotsTable}
      </section>
    </ConsoleV2Page>
  );
}
