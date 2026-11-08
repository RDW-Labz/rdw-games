'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { headers } from 'next/headers';
import { getSupabaseServer } from '@/lib/supabase-server';

const resolveSchema = z.object({
  disputeId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  decision: z.enum(['resolved', 'denied']),
  refundCents: z.number().int().nonnegative(),
  issueStripeRefund: z.boolean(),
  notes: z.string().nullable(),
});

export async function resolveDispute(input: z.infer<typeof resolveSchema>) {
  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'not authenticated' };

  // Optionally call our existing /api/invoices/[id]/refund route to issue
  // a Stripe refund. We use the inbound request's host so this works in
  // dev and prod without configuration.
  if (parsed.data.issueStripeRefund && parsed.data.refundCents > 0) {
    const h = await headers();
    const proto = h.get('x-forwarded-proto') ?? 'http';
    const host = h.get('host') ?? 'localhost:3000';
    const cookie = h.get('cookie') ?? '';
    const res = await fetch(`${proto}://${host}/api/invoices/${parsed.data.invoiceId}/refund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        amountCents: parsed.data.refundCents,
        reason: 'requested_by_customer',
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return {
        ok: false as const,
        error: `Card refund failed: ${err.error ?? res.statusText}`,
      };
    }
  }

  const { error: updErr } = await supabase
    .from('disputes')
    .update({
      status: parsed.data.decision,
      refund_cents: parsed.data.refundCents,
      resolution_notes: parsed.data.notes,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.disputeId);
  if (updErr) return { ok: false as const, error: updErr.message };

  // Notify the bidder via the outbox.
  const { data: dispute } = await supabase
    .from('disputes')
    .select('bidder_id')
    .eq('id', parsed.data.disputeId)
    .single();
  if (dispute?.bidder_id) {
    await supabase.from('notifications_outbox').insert({
      kind: 'dispute_update',
      target_user_id: dispute.bidder_id,
      payload: {
        dispute_id: parsed.data.disputeId,
        decision: parsed.data.decision,
        refund_cents: parsed.data.refundCents,
        message:
          parsed.data.decision === 'resolved'
            ? parsed.data.refundCents > 0
              ? `Refunded ${(parsed.data.refundCents / 100).toFixed(2)}.`
              : 'Your dispute was resolved.'
            : 'Your dispute was denied.',
      },
      idempotency_key: `dispute_update:${parsed.data.disputeId}:${parsed.data.decision}`,
    });
  }

  revalidatePath(`/disputes/${parsed.data.disputeId}`);
  revalidatePath('/disputes');
  return { ok: true as const };
}
