// /profile/optional-info — phone + explicit SMS consent + "how did you
// hear about us?" (migration 0448). Web counterpart of the bidder app's
// profile/edit.tsx optional-profile section and the one-time post-ZIP
// nudge (apps/bidder-app/components/ZipGateHost.tsx) — there is no nudge
// here (no single "next action" moment exists for every web bidder path),
// just the always-available editable fields.
//
// NOTE: not linked from /profile/page.tsx yet — that file is flagged
// off-limits in profile/notifications/page.tsx's header comment (in-flight
// branch conflict). A nav link should be added once that lands, same as
// the notifications page is waiting on.

import { SMS_CONSENT_ENABLED } from '@auction-platform/shared';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { OptionalInfoForm } from './OptionalInfoForm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function OptionalInfoPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login?next=/profile/optional-info');
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('phone, sms_consent_at, heard_about, heard_about_other')
    .eq('id', user.id)
    .maybeSingle();

  return (
    <main style={{ padding: '3rem 1.5rem 5rem', maxWidth: 520, margin: '0 auto' }}>
      <Link
        href="/profile"
        style={{
          fontSize: 13,
          color: 'var(--fg-muted)',
          textDecoration: 'none',
          display: 'inline-block',
          marginBottom: '2rem',
        }}
      >
        &larr; Back to profile
      </Link>

      <h1 style={{ fontSize: '1.75rem', fontWeight: 900, margin: '0 0 0.5rem' }}>
        {SMS_CONSENT_ENABLED ? 'Phone & a couple questions' : 'A couple of questions'}
      </h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.6, marginBottom: '2rem' }}>
        All optional — nothing here is required to bid or check out.
      </p>

      <OptionalInfoForm
        initialPhone={(bidderRow?.phone as string | null) ?? ''}
        consentedAt={(bidderRow?.sms_consent_at as string | null) ?? null}
        initialHeardAbout={(bidderRow?.heard_about as string | null) ?? null}
        initialHeardAboutOther={(bidderRow?.heard_about_other as string | null) ?? ''}
      />
    </main>
  );
}
