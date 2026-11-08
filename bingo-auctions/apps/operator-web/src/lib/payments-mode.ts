// Single TypeScript reader for platform_settings.payments_disabled (mig 0198).
// Shared by automatic payment collection and the bidder/operator payment gates.
// The database flag remains authoritative for SQL callers as well; keep this
// reader's existing false-on-error behavior so a read glitch cannot silently
// disable normal payment collection.

import { getSupabaseAdmin } from '@/lib/supabase-admin';

/**
 * Returns true when the platform is running WITHOUT a live card processor.
 * Reads platform_settings.payments_disabled via the service-role client (the
 * table is RLS-locked; service-role bypasses RLS).
 *
 * Fail-safe: any error (missing row, network) → false, i.e. normal payment
 * collection. A glitch must never silently stop real charging.
 */
export async function isPaymentsDisabled(): Promise<boolean> {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('platform_settings')
      .select('payments_disabled')
      .eq('id', true)
      .maybeSingle();
    if (error) {
      console.warn('[payments-mode] flag read failed, defaulting to enabled:', error.message);
      return false;
    }
    return Boolean(data?.payments_disabled);
  } catch (err) {
    console.warn(
      '[payments-mode] flag read threw, defaulting to enabled:',
      (err as Error)?.message,
    );
    return false;
  }
}
