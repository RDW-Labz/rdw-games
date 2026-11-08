// mirrors v1 auctions/[id]/page.tsx previewUrl — keep in sync
/** Public preview check-in URL encoded in the per-auction Preview QR (Option C). */
export function buildAuctionPreviewUrl(auctionId: string): string {
  return `https://bingoauctions.com/preview/${auctionId}`;
}
