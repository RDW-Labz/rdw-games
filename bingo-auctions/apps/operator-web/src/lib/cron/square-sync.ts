// square-sync.ts — Square directory sync + loyalty accrual sweep (mig 0236).
//
// Bridges the auction platform into the owner's wider Square account
// (25 locations incl. brick-and-mortar + Square Loyalty). Two independent,
// dashboard-toggled jobs, both incremental and exactly-once:
//
//   DIRECTORY (square_sync_enabled)
//     Bidders where square_synced_at IS NULL → ensure a Square customer
//     exists (create for cardless bidders; card-savers already have one via
//     ensureBidderSquareCustomer), backfill name/email/phone, add to the
//     "BinGo Auction Bidders" customer group (created on first run, id
//     cached in platform_settings.square_group_id). Stamp square_synced_at.
//     Square Marketing can then target the group next to in-store customers.
//
//   LOYALTY (square_loyalty_enabled)
//     Paid invoices with a square_payment_id and loyalty_accrued_at IS NULL
//     → find/enroll the bidder's loyalty account by phone (E.164; bidders
//     without a phone are stamped-skipped, not retried forever) →
//     AccumulateLoyaltyPoints with the payment id, so the program's own
//     earn rules decide the points. Stamp loyalty_accrued_at.
//     NOTE: offline-paid invoices (cash at pickup) have no square_payment_id
//     and never accrue — matches how the brick-and-mortar program works
//     (no payment, no points).
//
// Batches are small (15/tick each) — Workers subrequest budget — and the
// hourly cadence drains any backlog within a day.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  SquareApiError,
  getPayment,
  adoptOrCreateSquareCustomer,
  updateSquareCustomer,
  ensureCustomerGroup,
  addCustomerToGroup,
  getMainLoyaltyProgram,
  findOrCreateLoyaltyAccount,
  accumulateLoyaltyPoints,
  normalizePhoneE164,
} from '@/lib/square';

const GROUP_NAME = 'BinGo Auction Bidders';
const BATCH = 15;

export type SquareSyncResult = {
  directory: { enabled: boolean; synced: number; adopted: number; failed: number };
  loyalty: { enabled: boolean; accrued: number; skipped_no_phone: number; failed: number };
  // 0287: processing-fee backfill so Square DEPOSITS can be reconciled.
  fees: { filled: number; unsettled: number; failed: number };
};

// Moved to lib/square.ts (every Square customer call must normalize, not just
// the cron) — re-exported so existing importers keep working.
export { normalizePhoneE164 } from '@/lib/square';

// Fill invoices.square_processing_fee_cents / square_net_cents from Square for
// paid invoices that don't have them yet (mig 0287). Bounded per tick like the
// other sweeps; the hourly cadence drains the backlog. A payment Square hasn't
// settled yet simply reports no fee — we leave the columns NULL so the next tick
// retries, rather than writing a wrong 0 that would understate fees forever.
async function backfillSquareFees(result: SquareSyncResult): Promise<void> {
  const admin = getSupabaseAdmin();
  try {
    const { data: pending, error } = await admin
      .from('invoices')
      .select('id, square_payment_id')
      .not('square_payment_id', 'is', null)
      .is('square_processing_fee_cents', null)
      .not('paid_at', 'is', null)
      .order('paid_at', { ascending: true })
      .limit(BATCH);
    if (error) {
      // Most likely cause: migration 0287 not applied yet (unknown column).
      // Non-fatal — the rest of the sync still runs.
      result.fees.failed++;
      console.error('[square-sync] fee backfill query failed (mig 0287 applied?):', error.message);
      return;
    }

    for (const inv of pending ?? []) {
      try {
        const p = await getPayment(inv.square_payment_id as string);
        const fee = p?.processingFeeCents ?? null;
        if (fee == null) {
          // Not settled yet — try again on a later tick.
          result.fees.unsettled++;
          continue;
        }
        await admin
          .from('invoices')
          .update({
            square_processing_fee_cents: fee,
            square_net_cents: p?.netCents ?? null,
          })
          .eq('id', inv.id);
        result.fees.filled++;
      } catch (err) {
        result.fees.failed++;
        console.error(
          '[square-sync] fee backfill failed for invoice',
          inv.id,
          err instanceof SquareApiError ? `${err.status} ${err.message}` : (err as Error).message,
        );
      }
    }
  } catch (err) {
    result.fees.failed++;
    console.error('[square-sync] fee backfill setup failed:', (err as Error).message);
  }
}

export async function runSquareSync(): Promise<SquareSyncResult> {
  const admin = getSupabaseAdmin();

  const { data: settings } = await admin
    .from('platform_settings')
    .select('square_sync_enabled, square_loyalty_enabled, square_group_id')
    .eq('id', true)
    .maybeSingle();
  const syncOn = !!settings?.square_sync_enabled;
  const loyaltyOn = !!settings?.square_loyalty_enabled;

  const result: SquareSyncResult = {
    directory: { enabled: syncOn, synced: 0, adopted: 0, failed: 0 },
    loyalty: { enabled: loyaltyOn, accrued: 0, skipped_no_phone: 0, failed: 0 },
    fees: { filled: 0, unsettled: 0, failed: 0 },
  };

  // ── Processing-fee backfill (0287) ────────────────────────────────────────
  // Runs unconditionally — it is not a marketing feature and has no dashboard
  // toggle; without it the platform has no fee data and Square DEPOSITS can
  // never be reconciled (owner report 2026-07-24).
  //
  // Square finalizes processing_fee asynchronously at settlement, so a fee is
  // usually absent at charge time and appears the next business day. We sweep
  // paid invoices that still have no fee, oldest first, and skip silently when
  // Square still reports none (counted as `unsettled`, retried next tick).
  await backfillSquareFees(result);

  if (!syncOn && !loyaltyOn) return result;

  // ── Directory ─────────────────────────────────────────────────────────────
  if (syncOn) {
    let groupId = (settings?.square_group_id as string | null) ?? null;
    try {
      if (!groupId) {
        groupId = await ensureCustomerGroup(GROUP_NAME);
        await admin
          .from('platform_settings')
          .update({ square_group_id: groupId })
          .eq('id', true);
      }

      const { data: pending } = await admin
        .from('bidders')
        .select('id, email, display_name, phone, square_customer_id')
        .is('square_synced_at', null)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(BATCH);

      for (const b of pending ?? []) {
        try {
          const phone = normalizePhoneE164((b.phone as string | null) ?? null);
          let customerId = (b.square_customer_id as string | null) ?? null;
          if (!customerId) {
            // Adopt an existing in-store profile (email/phone match) before
            // ever creating — no duplicate profiles for store regulars.
            const adopted = await adoptOrCreateSquareCustomer({
              userId: b.id as string,
              email: (b.email as string | null) ?? null,
              displayName: (b.display_name as string | null) ?? null,
              phone,
            });
            customerId = adopted.id;
            if (adopted.adopted) result.directory.adopted++;
            await admin
              .from('bidders')
              .update({ square_customer_id: customerId })
              .eq('id', b.id);
          } else {
            // Existing (card-save-era) customer: backfill phone + freshen
            // name/email so Square Marketing has complete records.
            await updateSquareCustomer(customerId, {
              givenName: (b.display_name as string | null) ?? null,
              email: (b.email as string | null) ?? null,
              phone,
            });
          }
          await addCustomerToGroup(customerId, groupId);
          await admin
            .from('bidders')
            .update({ square_synced_at: new Date().toISOString() })
            .eq('id', b.id);
          result.directory.synced++;
        } catch (err) {
          result.directory.failed++;
          console.error(
            '[square-sync] directory sync failed for bidder',
            b.id,
            err instanceof SquareApiError ? `${err.status} ${err.message}` : (err as Error).message,
          );
        }
      }
    } catch (err) {
      // Group creation / listing failed (most likely a token-scope problem:
      // CUSTOMERS_WRITE missing). Loud, specific, non-fatal to loyalty.
      result.directory.failed++;
      console.error('[square-sync] directory setup failed (token scopes?):', (err as Error).message);
    }
  }

  // ── Loyalty ───────────────────────────────────────────────────────────────
  if (loyaltyOn) {
    try {
      const program = await getMainLoyaltyProgram();
      if (!program || program.status !== 'ACTIVE') {
        console.warn('[square-sync] no ACTIVE main loyalty program — loyalty accrual idle');
      } else {
        const { data: invoices } = await admin
          .from('invoices')
          .select('id, bidder_id, square_payment_id, paid_at, bidders(phone)')
          .eq('status', 'paid')
          .not('square_payment_id', 'is', null)
          .is('loyalty_accrued_at', null)
          .order('paid_at', { ascending: true })
          .limit(BATCH);

        for (const inv of invoices ?? []) {
          const rawPhone =
            ((inv as { bidders?: { phone?: string | null } | null }).bidders?.phone as
              | string
              | null) ?? null;
          const phone = normalizePhoneE164(rawPhone);
          if (!phone) {
            // No phone → can't enroll YET. Give the bidder 7 days to add one
            // (profile/onboarding now collect phone) before stamp-skipping,
            // so a win earns its points if they enroll the same week. The
            // operator can clear loyalty_accrued_at to force a re-try later.
            const paidAt = (inv as { paid_at?: string | null }).paid_at;
            const oldEnough =
              !paidAt || Date.now() - new Date(paidAt).getTime() > 7 * 86400_000;
            if (oldEnough) {
              await admin
                .from('invoices')
                .update({ loyalty_accrued_at: new Date().toISOString() })
                .eq('id', inv.id);
            }
            result.loyalty.skipped_no_phone++;
            continue;
          }
          try {
            const accountId = await findOrCreateLoyaltyAccount(program.id, phone);
            await accumulateLoyaltyPoints({
              accountId,
              paymentId: inv.square_payment_id as string,
              invoiceId: inv.id as string,
            });
            await admin
              .from('invoices')
              .update({ loyalty_accrued_at: new Date().toISOString() })
              .eq('id', inv.id);
            result.loyalty.accrued++;
          } catch (err) {
            result.loyalty.failed++;
            console.error(
              '[square-sync] loyalty accrual failed for invoice',
              inv.id,
              err instanceof SquareApiError ? `${err.status} ${err.message}` : (err as Error).message,
            );
          }
        }
      }
    } catch (err) {
      result.loyalty.failed++;
      console.error('[square-sync] loyalty setup failed (token scopes?):', (err as Error).message);
    }
  }

  return result;
}
