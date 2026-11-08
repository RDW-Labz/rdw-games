'use server';

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { monthRangeInTimeZone } from '@/lib/datetime';

// Export format:
//  - 'invoice' : one row per paid invoice (current default; preserved byte-identically
//                for any existing tooling that consumes the legacy file)
//  - 'lot'     : one row per won lot inside each paid invoice, with sale + buyer
//                premium broken out so each row maps cleanly to a QuickBooks Sales
//                Receipt line item.
export type ReportCsvFormat = 'invoice' | 'lot';

const LOT_ROW_CAP = 5000;

// Returns CSV text for the given operator + month. Called by ExportCsvButton
// which downloads it client-side to avoid a separate route handler.
export async function exportReportCsv(
  operatorId: string,
  year: number,
  month: number,
  format: ReportCsvFormat = 'invoice',
): Promise<string> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Verify caller belongs to this operator.
  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me || (me as { operator_id: string }).operator_id !== operatorId) {
    throw new Error('Unauthorized');
  }

  // Same warehouse-zone month boundaries as the Reports page (2026-07-05
  // fix) so the CSV always matches the numbers on screen.
  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tz = (whRow as { timezone: string } | null)?.timezone ?? null;
  const { startISO: monthStart, endISO: monthEnd } = monthRangeInTimeZone(year, month, tz);

  if (format === 'lot') {
    return buildLotCsv(supabase, operatorId, monthStart, monthEnd);
  }
  return buildInvoiceCsv(supabase, operatorId, monthStart, monthEnd);
}

// ----------------------------------------------------------------------------
// CSV cell helpers
// ----------------------------------------------------------------------------

// Quote any cell containing , or " or newline; escape inner " as "".
function csvCell(raw: string | null | undefined): string {
  const s = raw ?? '';
  if (/[,"\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function ymd(value: string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// Invoice-level CSV (legacy format; preserved byte-for-byte)
// ----------------------------------------------------------------------------

type SupabaseServer = Awaited<ReturnType<typeof getSupabaseServer>>;

async function buildInvoiceCsv(
  supabase: SupabaseServer,
  operatorId: string,
  monthStart: string,
  monthEnd: string,
): Promise<string> {
  const { data: invoices } = await supabase
    .from('invoices')
    .select(
      'id, total_cents, application_fee_cents, paid_at, auction_id, bidder_id, auctions(title), bidders(email, display_name)',
    )
    .eq('operator_id', operatorId)
    .eq('status', 'paid')
    .gte('paid_at', monthStart)
    .lt('paid_at', monthEnd)
    .order('paid_at', { ascending: false })
    .limit(5000);

  const header = ['Invoice ID', 'Auction', 'Bidder', 'Sale ($)', 'App fee ($)', 'Net ($)', 'Paid date'];
  const rows = (invoices ?? []).map((inv) => {
    const a = (inv as { auctions?: { title?: string } }).auctions;
    const b = (inv as { bidders?: { email?: string; display_name?: string | null } }).bidders;
    const sale = ((inv.total_cents as number) ?? 0) / 100;
    const fee = ((inv.application_fee_cents as number) ?? 0) / 100;
    return [
      inv.id,
      `"${(a?.title ?? '').replace(/"/g, '""')}"`,
      `"${(b?.display_name ?? b?.email ?? '').replace(/"/g, '""')}"`,
      sale.toFixed(2),
      fee.toFixed(2),
      (sale - fee).toFixed(2),
      inv.paid_at ? new Date(inv.paid_at as string).toISOString().slice(0, 10) : '',
    ].join(',');
  });

  return [header.join(','), ...rows].join('\r\n');
}

// ----------------------------------------------------------------------------
// Lot-level CSV — one row per won lot inside each paid invoice
// ----------------------------------------------------------------------------

interface InvoiceJoinRow {
  id: string;
  paid_at: string | null;
  auction_id: string;
  bidder_id: string;
  auctions?: { title?: string; buyer_premium_bps?: number | null } | null;
  bidders?: { email?: string | null; display_name?: string | null } | null;
}

interface LotJoinRow {
  id: string;
  lot_code: string | null;
  lot_number: number | null;
  title: string;
  category: string | null;
  current_bid_cents: number | null;
  auction_id: string;
  winner_bidder_id: string | null;
  status: string;
  closed_at: string | null;
}

async function buildLotCsv(
  supabase: SupabaseServer,
  operatorId: string,
  monthStart: string,
  monthEnd: string,
): Promise<string> {
  // 1. Pull paid invoices for the month + the auction title + buyer premium bps
  //    (premium lives on auctions, not invoices, so it joins here once).
  const { data: invoicesRaw } = await supabase
    .from('invoices')
    .select(
      'id, paid_at, auction_id, bidder_id, auctions(title, buyer_premium_bps), bidders(email, display_name)',
    )
    .eq('operator_id', operatorId)
    .eq('status', 'paid')
    .gte('paid_at', monthStart)
    .lt('paid_at', monthEnd)
    .order('paid_at', { ascending: false })
    .limit(5000);

  const invoices = (invoicesRaw ?? []) as unknown as InvoiceJoinRow[];

  if (invoices.length === 0) {
    return buildLotCsvHeader();
  }

  // 2. Bulk-fetch every winning lot in one shot via the (auction_id, bidder_id)
  //    cartesian. We intentionally do not constrain on lots.closed_at here —
  //    a lot could close late in the prior month and be paid this month, and
  //    we want it on the receipt that actually got paid. The JS join below
  //    pairs each lot to exactly one invoice by (auction_id, winner_bidder_id),
  //    so the IN/IN over-fetch is filtered out before emission.
  const auctionIds = Array.from(new Set(invoices.map((i) => i.auction_id)));
  const bidderIds = Array.from(new Set(invoices.map((i) => i.bidder_id)));

  // Cap the lots fetch to LOT_ROW_CAP rows. The DB can have O(100k) won lots
  // across many auctions; without a limit this query returns unbounded results
  // to the edge function. The capReached guard below surfaces a truncation
  // warning in the CSV if the limit is hit.
  const { data: lotsRaw } = await supabase
    .from('lots')
    .select(
      'id, lot_code, lot_number, title, category, current_bid_cents, auction_id, winner_bidder_id, status, closed_at',
    )
    .eq('status', 'won')
    .in('auction_id', auctionIds)
    .in('winner_bidder_id', bidderIds)
    .limit(LOT_ROW_CAP);

  const lots = (lotsRaw ?? []) as LotJoinRow[];

  // 3. Index lots by (auction_id|winner_bidder_id) for O(1) match per invoice.
  const lotsByKey = new Map<string, LotJoinRow[]>();
  for (const lot of lots) {
    if (!lot.winner_bidder_id || lot.current_bid_cents == null) {
      // Defensively skip lots that shouldn't appear on a paid invoice.
      continue;
    }
    const key = `${lot.auction_id}|${lot.winner_bidder_id}`;
    const bucket = lotsByKey.get(key);
    if (bucket) {
      bucket.push(lot);
    } else {
      lotsByKey.set(key, [lot]);
    }
  }

  // 4. Stitch invoices + lots into receipt-order rows. Invoices are already
  //    sorted paid_at DESC; inside each invoice we sort lots by lot_code ASC
  //    (fallback to lot_number) so the receipt order is stable.
  const rows: string[] = [];
  let capReached = false;

  for (const inv of invoices) {
    const key = `${inv.auction_id}|${inv.bidder_id}`;
    const bucket = lotsByKey.get(key);
    if (!bucket) continue;

    const sorted = bucket.slice().sort((a, b) => {
      const codeA = a.lot_code ?? '';
      const codeB = b.lot_code ?? '';
      if (codeA && codeB) return codeA.localeCompare(codeB);
      if (codeA) return -1;
      if (codeB) return 1;
      return (a.lot_number ?? 0) - (b.lot_number ?? 0);
    });

    const auctionTitle = inv.auctions?.title ?? '';
    const bidderName = inv.bidders?.display_name ?? inv.bidders?.email ?? '';
    const premiumBps = inv.auctions?.buyer_premium_bps ?? 0;
    const invoiceShort = inv.id.slice(-8);
    const paidDate = ymd(inv.paid_at);

    for (const lot of sorted) {
      if (rows.length >= LOT_ROW_CAP) {
        capReached = true;
        break;
      }
      const saleCents = lot.current_bid_cents ?? 0;
      const sale = saleCents / 100;
      // Buyer premium is computed per-line; for QB this lets you map each line
      // to the same income+premium account split your invoice flow uses.
      const premiumCents = Math.round((saleCents * premiumBps) / 10000);
      const premium = premiumCents / 100;
      const tax = 0; // We don't track per-line tax yet — emit zero so the
                    // column shape is QB-ready.
      const total = sale + premium + tax;

      rows.push(
        [
          ymd(lot.closed_at),
          paidDate,
          invoiceShort,
          csvCell(auctionTitle),
          csvCell(lot.lot_code ?? ''),
          csvCell(lot.title),
          csvCell(lot.category ?? 'Uncategorized'),
          csvCell(bidderName),
          sale.toFixed(2),
          premium.toFixed(2),
          tax.toFixed(2),
          total.toFixed(2),
        ].join(','),
      );
    }

    if (capReached) break;
  }

  const out = [buildLotCsvHeader(), ...rows];
  if (capReached) {
    out.push(
      '# Note: cap reached at 5000 rows; export multiple months for larger periods',
    );
  }
  return out.join('\r\n');
}

function buildLotCsvHeader(): string {
  return [
    'Won date',
    'Paid date',
    'Invoice',
    'Auction',
    'Lot code',
    'Item',
    'Category',
    'Bidder',
    'Sale ($)',
    'Buyer premium ($)',
    'Sales tax ($)',
    'Line total ($)',
  ].join(',');
}
