'use client';

// Non-dismissible (for 7 days) banner shown at the top of the operator
// console when the current user is an admin who has not yet enrolled a
// TOTP factor (LAUNCH_PLAN §3.1c, Task 4).
//
// Three states:
//   1. Within grace window (< 7 days since admin_first_seen_at, or never
//      seen yet) → banner is NOT dismissible. The user has to set up MFA
//      to dismiss it.
//   2. Past grace window (>= 7 days) → banner becomes dismissible (the
//      × button appears). Dismissal is per-browser via localStorage.
//   3. Once the user enrolls a verified TOTP factor, the layout stops
//      rendering this component entirely — there's no need to "re-dismiss"
//      it after enrolling.
//
// The 7-day clock starts at the first admin sign-in, NOT at row creation
// (operator_users can be created before the user actually signs in via
// the invite flow). The admin layout stamps admin_first_seen_at to NOW()
// the first time this component would have been rendered.
//
// IMPORTANT: dismissal does NOT unlock the AAL2 gate on sensitive pages.
// The middleware still redirects /staff, /billing, /account, /payouts
// to the step-up page. After the grace window, an admin who dismisses
// this banner has effectively chosen to lose access to those routes
// until they enroll.

import { useEffect, useState } from 'react';
import Link from 'next/link';

const STORAGE_KEY_PREFIX = 'bidwizops:mfa-banner-dismissed:';
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export function MfaSetupBanner({
  userId,
  adminFirstSeenAt,
}: {
  userId: string;
  // ISO timestamp of the first time this admin loaded the operator console.
  // null means "never" — which the parent layout treats as "just now" by
  // stamping the column server-side. By the time this component renders,
  // the value is always non-null.
  adminFirstSeenAt: string;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(localStorage.getItem(STORAGE_KEY_PREFIX + userId) === '1');
    setHydrated(true);
  }, [userId]);

  // Banner becomes dismissible after the grace period elapses.
  const firstSeenMs = new Date(adminFirstSeenAt).getTime();
  const elapsed = Date.now() - firstSeenMs;
  const isDismissible = elapsed >= GRACE_PERIOD_MS;
  const daysRemaining = Math.max(
    0,
    Math.ceil((GRACE_PERIOD_MS - elapsed) / (24 * 60 * 60 * 1000)),
  );

  if (!hydrated) return null;
  if (isDismissible && dismissed) return null;

  function dismiss(): void {
    localStorage.setItem(STORAGE_KEY_PREFIX + userId, '1');
    setDismissed(true);
  }

  return (
    <div
      style={{
        margin: '0 -2rem 1.5rem -2rem', // span full main width
        padding: '0.85rem 2rem',
        background: 'rgba(255, 165, 0, 0.10)',
        borderBottom: '1px solid rgba(255, 165, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        flexWrap: 'wrap',
        fontSize: 14,
        position: 'relative',
      }}
      role="alert"
    >
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>
        <strong style={{ color: 'orange' }}>Set up two-factor authentication</strong>
        {' — '}
        Required for admin accounts. Staff management, billing, and account
        settings are locked until you enroll an authenticator app.
        {!isDismissible && daysRemaining > 0 && (
          <span style={{ color: 'var(--fg-muted)' }}>
            {' '}
            (Reminder will be dismissible after {daysRemaining} day
            {daysRemaining === 1 ? '' : 's'}.)
          </span>
        )}
      </div>
      <Link
        href="/account/security"
        style={{
          padding: '0.4rem 0.9rem',
          background: 'var(--accent)',
          color: '#fff',
          borderRadius: 4,
          textDecoration: 'none',
          fontSize: 13,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        Set up now →
      </Link>
      {isDismissible && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          title="Dismiss (sensitive pages stay locked until you enroll)"
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            border: 'none',
            background: 'transparent',
            color: 'var(--fg-muted)',
            cursor: 'pointer',
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
