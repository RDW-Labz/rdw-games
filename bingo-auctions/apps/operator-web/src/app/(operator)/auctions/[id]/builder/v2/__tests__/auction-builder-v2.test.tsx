import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AuctionBuilderLockedV2, AuctionBuilderV2 } from '../AuctionBuilderV2';

describe('AuctionBuilderV2', () => {
  it('wraps builder controls and shows motion reveal', () => {
    const html = renderToString(
      <AuctionBuilderV2
        auctionId="a1"
        auctionTitle="Sample"
        backHref="/auctions/a1"
        intro={<span>Intro copy</span>}
        notices={[]}
        builder={<span>Builder fixture</span>}
      />,
    );
    expect(html).toContain('Builder fixture');
    expect(html).toContain('console-v2-motion-reveal');
  });

  it('shows locked state for live auctions', () => {
    const html = renderToString(
      <AuctionBuilderLockedV2 auctionId="a-live" status="live" backHref="/auctions/a-live" />,
    );
    expect(html).toContain('Lot membership is locked');
    expect(html).toContain('live');
  });
});
