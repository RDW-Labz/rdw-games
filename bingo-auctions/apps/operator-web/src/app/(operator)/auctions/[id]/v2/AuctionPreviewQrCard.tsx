import Image from 'next/image';
import { buildAuctionPreviewUrl } from './auction-preview-url';

export type AuctionPreviewQrCardProps = {
  auctionId: string;
  auctionTitle: string;
  previewQrDataUrl: string;
};

export function AuctionPreviewQrCard({
  auctionId,
  auctionTitle,
  previewQrDataUrl,
}: AuctionPreviewQrCardProps) {
  const previewUrl = buildAuctionPreviewUrl(auctionId);

  return (
    <section
      className="console-v2-auction-detail-preview-qr console-v2-motion-reveal"
      aria-label="Preview QR"
      data-preview-url={previewUrl}
    >
      <div className="console-v2-auction-detail-preview-qr-image-wrap">
        <Image
          src={previewQrDataUrl}
          alt={`Preview QR for ${auctionTitle}`}
          width={180}
          height={180}
          unoptimized
        />
      </div>
      <div className="console-v2-auction-detail-preview-qr-copy">
        <h2 className="console-v2-auction-detail-preview-qr-title">Preview QR</h2>
        <p className="console-v2-auction-detail-preview-qr-body">
          Print or display this at your warehouse door. A bidder scans it once in the{' '}
          <strong>BinGo Auctions app</strong> to start previewing this auction — after that they can
          scan the stickers on your lots to open or watchlist them. Scanning with a plain phone
          camera just opens the public auction page.
        </p>
        <a
          href={previewQrDataUrl}
          download={`preview-qr-${auctionId}.png`}
          className="console-v2-btn console-v2-btn--secondary console-v2-pressable"
        >
          ⬇ Download PNG
        </a>
      </div>
    </section>
  );
}
