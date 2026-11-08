import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock('next/image', () => ({
  default: ({
    src,
    alt,
    width,
    height,
  }: {
    src: string;
    alt: string;
    width: number;
    height: number;
  }) => <img src={src} alt={alt} width={width} height={height} />,
}));

import { renderToString } from 'react-dom/server';
import { formatCount } from '@/app/(operator)/dashboard/v2/floor-story';
import { statusPresentation } from '@/components/console-v2/status';
import { buildAuctionPreviewUrl } from '../auction-preview-url';
import { AuctionDetailV2 } from '../AuctionDetailV2';
import {
  auctionDetailDraftV2Fixture,
  auctionDetailLiveV2Fixture,
} from '../__fixtures__/auction-detail-fixture';

describe('AuctionDetailV2', () => {
  it('shows Edit and Schedule only when draft allows them', () => {
    const draftHtml = renderToString(<AuctionDetailV2 {...auctionDetailDraftV2Fixture} />);
    expect(draftHtml).toContain('href="/auctions/a-draft-1/edit"');
    expect(draftHtml).toContain('Schedule auction');

    const liveHtml = renderToString(<AuctionDetailV2 {...auctionDetailLiveV2Fixture} />);
    expect(liveHtml).not.toContain('href="/auctions/a-live-1/edit"');
    expect(liveHtml).not.toMatch(/>\s*Schedule auction\s*<\/button>/);
  });

  it('uses status pill tokens by meaning', () => {
    const html = renderToString(<AuctionDetailV2 {...auctionDetailLiveV2Fixture} />);
    const live = statusPresentation('live');
    expect(html).toContain(live.background);
  });

  it('renders setup stepper with motion', () => {
    const html = renderToString(<AuctionDetailV2 {...auctionDetailDraftV2Fixture} />);
    expect(html).toContain('console-v2-setup-step');
    expect(html.match(/console-v2-motion-row-in/g)?.length).toBeGreaterThan(0);
  });

  it('renders lot summary tiles, provenance, and preview QR with fixture values', () => {
    const f = auctionDetailDraftV2Fixture;
    const html = renderToString(<AuctionDetailV2 {...f} />);

    expect(html).toContain('Total lots');
    expect(html).toContain(formatCount(f.totalLots));
    expect(html).toContain('Opening');
    expect(html).toContain(formatCount(f.activeLots));
    expect(html).toContain(formatCount(f.totalBids));
    expect(html).toContain(formatCount(f.noBidLots));

    expect(html).toContain('Provenance of 107 lots:');
    expect(html).toContain('Newly-added');
    expect(html).toContain(formatCount(f.newlyAddedLots));
    expect(html).toContain('Carried-over');
    expect(html).toContain('Forfeited-return');
    expect(html).toContain('first-time lots');

    expect(html).toContain('Preview QR');
    expect(html).toContain(f.previewQrDataUrl);
    expect(html).toContain(`download="preview-qr-${f.auctionId}.png"`);
    expect(html).toContain(`data-preview-url="${buildAuctionPreviewUrl(f.auctionId)}"`);
  });

  it('preview QR encodes the same public URL as v1 for the auction id', () => {
    const auctionId = auctionDetailLiveV2Fixture.auctionId;
    const expected = `https://bingoauctions.com/preview/${auctionId}`;
    expect(buildAuctionPreviewUrl(auctionId)).toBe(expected);

    const html = renderToString(<AuctionDetailV2 {...auctionDetailLiveV2Fixture} />);
    expect(html).toContain(`data-preview-url="${expected}"`);
    expect(html).toContain('Live now');
    expect(html).toContain(formatCount(auctionDetailLiveV2Fixture.wonLots));
  });
});
