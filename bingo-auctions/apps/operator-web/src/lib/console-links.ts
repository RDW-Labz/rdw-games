export const lotHref = (id: string) => `/lots/${id}`;
export const auctionHref = (id: string) => `/auctions/${id}`;
export const invoiceHref = (id: string) => `/invoices/${id}`;
export const pickupSessionHref = (token: string) => `/pickups/session/${token}`;
// Read-only "as listed" view of the exact lot row that sold on this invoice
// — title/description/condition/photos exactly as advertised, staff-only.
// Scoped under the invoice (not just /lots/[id], which is the live, editable
// console lot page) because the sale-time comparison needs invoiceId to read
// that invoice's paid_at.
export const lotAsListedHref = (invoiceId: string, lotId: string) =>
  `/invoices/${invoiceId}/lots/${lotId}/as-listed`;

export function pairCodesWithIds(
  codes: string[] | null,
  ids: string[] | null,
): Array<{ code: string; id: string | null }> {
  const codeList = codes ?? [];
  const idList = ids ?? [];
  return codeList.map((code, i) => ({ code, id: idList[i] ?? null }));
}

export function pickLatestOpenSession<
  T extends { status: string; created_at: string; token: string },
>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  const byNewest = (a: T, b: T) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  const open = rows.filter((r) => r.status === 'open').sort(byNewest);
  if (open.length > 0) return open[0]!;
  return [...rows].sort(byNewest)[0]!;
}
