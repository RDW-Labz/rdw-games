import Link from 'next/link';
import type { ReactNode } from 'react';
import { ConsoleV2Page } from '@/components/console-v2/ConsoleV2Page';
import { SectionHeader } from '@/components/console-v2/SectionHeader';

export type AuctionBuilderV2Props = {
  auctionId: string;
  auctionTitle: string;
  backHref: string;
  intro: ReactNode;
  notices: ReactNode[];
  builder: ReactNode;
};

export function AuctionBuilderV2({
  auctionTitle,
  backHref,
  intro,
  notices,
  builder,
}: AuctionBuilderV2Props) {
  return (
    <ConsoleV2Page className="console-v2-auction-builder">
      <header className="console-v2-motion-reveal">
        <div className="console-v2-auction-builder-head">
          <h1 className="console-v2-display">Build auction</h1>
          <Link href={backHref} className="console-v2-btn console-v2-btn--secondary console-v2-pressable">
            ← Auction
          </Link>
        </div>
        <p className="console-v2-auction-builder-sub" style={{ color: 'var(--console-ink-secondary)' }}>
          {auctionTitle}
        </p>
      </header>

      <div className="console-v2-auction-builder-intro console-v2-motion-reveal">{intro}</div>

      {notices.map((notice, idx) => (
        <div
          key={idx}
          className="console-v2-auction-builder-notice console-v2-motion-reveal"
          style={{ ['--console-row-index' as string]: idx }}
        >
          {notice}
        </div>
      ))}

      <section className="console-v2-auction-builder-work console-v2-motion-reveal">
        <SectionHeader title="Add lots" stageHue="auction" />
        {builder}
      </section>
    </ConsoleV2Page>
  );
}

export type AuctionBuilderLockedV2Props = {
  auctionId: string;
  status: string;
  backHref: string;
};

export function AuctionBuilderLockedV2({ auctionId, status, backHref }: AuctionBuilderLockedV2Props) {
  return (
    <ConsoleV2Page className="console-v2-auction-builder">
      <header className="console-v2-motion-reveal">
        <div className="console-v2-auction-builder-head">
          <h1 className="console-v2-display">Build auction</h1>
          <Link href={backHref} className="console-v2-btn console-v2-btn--secondary console-v2-pressable">
            ← Auction
          </Link>
        </div>
      </header>
      <p className="console-v2-auction-builder-locked console-v2-motion-reveal">
        This auction is <strong>{status}</strong>. Lot membership is locked once the auction is live or closed.
      </p>
      <p className="console-v2-visually-hidden">Auction id {auctionId}</p>
    </ConsoleV2Page>
  );
}
