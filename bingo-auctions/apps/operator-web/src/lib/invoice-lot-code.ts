// The lot code that goes on a bidder's payment receipt.
//
// `invoices.primary_lot_code` DOES NOT EXIST — the invoices table has 48
// columns and that is not one of them. It is a field the auto-charge worker
// COMPUTES in memory (`auto-charge-drain.ts:164-176`) by joining invoice_lots
// and keeping the first lot's code. Two API routes copied the field name off
// that in-memory row and tried to `.select()` it from the table:
//
//   • api/invoices/[id]/mark-paid/route.ts — PostgREST rejects the unknown
//     column, `error` is set, and the route returns 500 on EVERY call.
//   • api/square/webhook/route.ts — the `.update().select()` fails, so
//     `flipped` comes back empty and the `payment_succeeded` receipt loop
//     never runs. Square payments were silently producing no receipt.
//
// So this does the join the worker does. It also resolves through
// `lotDisplayCode`, which means a receipt now names the label physically on
// the box ("TEA4951993") rather than a synthetic "BIN-######" the buyer has
// never seen — the same rule the pickup pass and the staff counter use.

import { lotDisplayCode, type LotCodeFields } from '@auction-platform/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

type LotLink = {
  lots:
    | (LotCodeFields & {
        relisted_from?: LotCodeFields | null;
      })
    | null;
};

/**
 * The display code of the first lot on an invoice, or null when the invoice
 * has no lots (or the lookup fails — a receipt is worth more than a lot code,
 * so this never throws and never blocks the enqueue).
 */
export async function primaryLotDisplayCode(
  admin: SupabaseClient,
  invoiceId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('invoice_lots')
    .select(
      `lots(lot_code, sticker_code, display_code,
         relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code,
           relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code)))`,
    )
    .eq('invoice_id', invoiceId)
    .limit(1);

  if (error || !data?.length) return null;
  const lot = (data as unknown as LotLink[])[0]?.lots;
  if (!lot) return null;
  return lotDisplayCode(lot) ?? lot.lot_code ?? null;
}
