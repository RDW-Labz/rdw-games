// Bidder web account deletion — bingoauctions.com/profile/delete-account
//
// CCPA / GDPR parity gap (PATCH-launch-readiness §3 item 4): the mobile app
// has an in-app delete-account flow (Apple Guideline 5.1.1(v)), but web bidders
// had no equivalent. This page mirrors apps/bidder-app/app/profile/delete-account.tsx:
//   1. Auth-gate (server component).
//   2. Show the "what will happen" list.
//   3. User types their email to confirm intent (client form).
//   4. Calls the SAME `delete_my_account` RPC the mobile app uses — it
//      anonymizes the bidder + tombstones auth.users (migration 0089), keeping
//      settled invoices for the 7-year tax-retention window with PII stripped.
//   5. Signs out + returns to the landing page.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { DeleteAccountForm } from './DeleteAccountForm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONSEQUENCES = [
  'Your email, name, phone, and date of birth are removed from our records.',
  'You will no longer be able to sign in with this account.',
  'Your saved searches, watchlist, and any active bidder subscriptions are deleted.',
  'Any pending invoices are canceled.',
  'Settled invoices and bid history are retained for 7 years to satisfy tax and audit requirements, with all personal identifiers removed.',
  'You can create a new account with the same email later if you change your mind.',
];

export default async function DeleteAccountPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/profile/delete-account');
  }

  return (
    <main style={{ padding: '3rem 1.5rem 5rem', maxWidth: 640, margin: '0 auto' }}>
      <Link
        href="/profile"
        style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}
      >
        &larr; Back to account
      </Link>

      <h1
        style={{
          fontSize: 'clamp(1.5rem, 4vw, 2rem)',
          fontWeight: 900,
          letterSpacing: -0.75,
          margin: '1.5rem 0 1rem',
        }}
      >
        Permanently delete your account?
      </h1>

      <p style={{ color: 'var(--fg-muted)', fontSize: 15, lineHeight: 1.6, margin: '0 0 1.25rem' }}>
        This action cannot be undone. Once you delete your BinGo Auctions account:
      </p>

      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 2rem', display: 'grid', gap: '0.6rem' }}>
        {CONSEQUENCES.map((line) => (
          <li key={line} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--danger)', flexShrink: 0 }}>&bull;</span>
            <span style={{ color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.55 }}>{line}</span>
          </li>
        ))}
      </ul>

      <DeleteAccountForm accountEmail={user.email ?? ''} />
    </main>
  );
}
