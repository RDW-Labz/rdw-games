// Final Call's realtime path fetches a newly in-window lot by id. It shows the
// lot only if its auction is in the server-resolved set (listed, non-demo,
// active) — the same gate the server list uses. Missing auction → not shown.
export function isFromListedAuction(
  auctionId: string | null | undefined,
  listed: ReadonlySet<string>,
): boolean {
  return typeof auctionId === 'string' && listed.has(auctionId);
}
