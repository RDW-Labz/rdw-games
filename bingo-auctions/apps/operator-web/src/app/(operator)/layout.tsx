// Layout for the (operator) route group — sidebar nav + auth guard.
// Server component: fetches the operator and the staff role for the current user.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { getSupabaseServer } from '@/lib/supabase-server';
import { isSuperAdmin } from '@/lib/super-admin';
import { PostHogIdentify } from '@/lib/posthog';
import { currentBuildId } from '@/lib/build-id';
import { isGrowthHubEnabled } from '@/lib/growth-hub';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { MfaSetupBanner } from './MfaSetupBanner';
import { BuildSkewNotice } from './BuildSkewNotice';
import { SignOutLink } from './SignOutLink';
import { ConsoleUiToggle } from './ConsoleUiToggle';
import { ConsoleShellV2 } from './_shell-v2/ConsoleShellV2';
import { GROWTH_NAV_GROUP } from './_shell-v2/nav-model';

// Routes inside (operator) that are exempt from the force-password-rotate
// redirect. The rotate page itself MUST be reachable, otherwise the user
// is stuck in a loop. /api routes never come through this layout.
const ROTATE_EXEMPT_PREFIXES = [
  '/account/rotate-password',
];

const navLinkStyle: React.CSSProperties = {
  padding: '4px 0',
  fontSize: 14,
};

// Tiny visual divider for sidebar groups. Adds breathing room and a
// muted uppercase label so the nav reads as sections rather than one
// long flat list.
function NavSection({ label }: { label: string }) {
  return (
    <div
      style={{
        marginTop: '1rem',
        marginBottom: '0.25rem',
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 1.4,
        textTransform: 'uppercase',
        color: 'var(--fg-dim)',
      }}
    >
      {label}
    </div>
  );
}

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: staff } = await supabase
    .from('operator_users')
    .select(
      'id, operator_id, role, force_password_rotate, admin_first_seen_at, operators(business_name)',
    )
    .eq('user_id', user.id)
    .single();

  // Single-operator build: there is no operator self-onboarding flow. A
  // signed-in user with no operator_users row is not staff (e.g. a bidder
  // who hit an operator URL) — send them to the public home.
  if (!staff) redirect('/');

  // §1.7: forced-rotate gate. The staff member was created via direct-
  // password invite; we won't let them touch the rest of the console
  // until they pick their own password. /account/rotate-password is the
  // only path that's exempt — that's where they go to clear the flag.
  // We read the current pathname from the middleware-set x-pathname
  // header (set in middleware.ts) to know whether we're already on the
  // rotate page. Fallback to the referer/url header if the helper isn't
  // set (defensive — older deploys without the middleware update).
  if ((staff as { force_password_rotate?: boolean }).force_password_rotate) {
    const h = await headers();
    const pathname =
      h.get('x-pathname') ??
      // Fallback: parse Next's x-invoke-path or referrer (best-effort).
      h.get('x-invoke-path') ??
      '';
    const exempt = ROTATE_EXEMPT_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + '/'),
    );
    if (!exempt) {
      redirect('/account/rotate-password');
    }
  }

  const operatorId = (staff as { operator_id?: string }).operator_id ?? null;
  const role = (staff as { role?: string }).role ?? null;
  const staffRowId = (staff as { id?: string }).id ?? null;
  const adminFirstSeenAtRaw =
    (staff as { admin_first_seen_at?: string | null }).admin_first_seen_at ?? null;

  // §3.1c — MFA enforcement. Two things happen here for super-admin users:
  //   1. If admin_first_seen_at IS NULL, stamp it to NOW(). This starts
  //      the 7-day grace clock used by the banner.
  //   2. Decide whether the user needs the "Set up MFA" banner. We render
  //      it only when role = 'admin' AND the user is on the SUPER_ADMIN
  //      allowlist AND there is no verified TOTP factor. Once they enroll,
  //      this branch flips automatically and the banner disappears.
  //
  // 2026-05-23 scope tightening: previously the banner showed for ANY
  // operator with role='admin' (i.e., BinGo's admin staff would see it
  // even though they're not platform super-admins). Per launch-week
  // decision, MFA enforcement is platform-super-admin-scoped only.
  // Operator-tenant admins are not forced into TOTP at launch. We can
  // tighten this back up post-launch once operators are comfortable
  // with the rest of the console.
  let showMfaBanner = false;
  let adminFirstSeenAt: string | null = adminFirstSeenAtRaw;
  if (role === 'admin' && isSuperAdmin(user.email)) {
    // List factors via the user's own session — Supabase exposes this on
    // the auth client without needing service-role.
    const { data: factorsData } = await supabase.auth.mfa.listFactors();
    const hasVerifiedTotp = (factorsData?.all ?? []).some(
      (f) => f.factor_type === 'totp' && f.status === 'verified',
    );
    if (!hasVerifiedTotp) {
      showMfaBanner = true;

      // Stamp first-seen timestamp if missing. We do this lazily here
      // rather than in /api/auth/callback so it survives older accounts
      // and pre-existing admins who already had a row in operator_users
      // before this column was added.
      if (!adminFirstSeenAt && staffRowId) {
        const stampedAt = new Date().toISOString();
        // Audit F-01 (2026-05-18): migration 0091 dropped the broad
        // operator_users_self_update RLS policy that allowed self-role-
        // escalation. Stamp via the dedicated column-scoped RPC.
        const { error } = await supabase.rpc('stamp_admin_first_seen');
        // Use the stamp for banner rendering regardless of UPDATE success
        // (RLS failures fall back to "now" so the user sees the banner;
        // next request retries the update).
        adminFirstSeenAt = stampedAt;
        if (error) {
          console.warn('admin_first_seen_at stamp failed:', error.message);
        }
      }
    }
  }

  const cookieStore = await cookies();
  const consoleV2 = isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value);
  const growthHubEnabled = isGrowthHubEnabled();
  const showGrowthNav = growthHubEnabled && role === 'admin';

  // Console v2 (?ui=v2): every check above has already run. Only the shell's
  // presentation differs — same nav (mirrored in _shell-v2/nav-model.ts and
  // parity-tested), same notices in the same order, same sign out, and the
  // ?ui=v1 switch back moves into the header. The v1 JSX below is untouched.
  if (consoleV2) {
    return (
      <ConsoleShellV2
        operatorName={
          (staff as unknown as { operators?: { business_name?: string } }).operators
            ?.business_name ?? 'Unknown'
        }
        role={role}
        growthHubEnabled={growthHubEnabled}
        analytics={<PostHogIdentify userId={user.id} operatorId={operatorId} role={role} />}
        notices={
          <>
            <BuildSkewNotice pageBuild={currentBuildId()} />
            {showMfaBanner && adminFirstSeenAt && (
              <MfaSetupBanner userId={user.id} adminFirstSeenAt={adminFirstSeenAt} />
            )}
          </>
        }
      >
        {children}
      </ConsoleShellV2>
    );
  }

  return (
    // op-shell (globals.css) replaces the old inline `240px 1fr` grid so it can
    // collapse to one column under 900px — inline styles cannot carry a media
    // query, which is why this console had no mobile layout at all.
    <div className="op-shell">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          padding: '0.5rem 1rem',
          background: 'var(--bg)',
          color: 'var(--fg)',
          zIndex: 9999,
          textDecoration: 'none',
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        Skip to main content
      </a>
      <PostHogIdentify userId={user.id} operatorId={operatorId} role={role} />
      {/* CSS-only nav drawer: the checkbox holds open/closed state and the label
          is the hamburger, so the sidebar collapses on phones without turning
          this server component into a client one. Both are display:none above
          900px, where the sidebar is always visible. The checkbox must precede
          the <aside> for the `:checked ~ .op-sidebar` sibling selector. */}
      <input
        type="checkbox"
        id="op-nav-toggle"
        className="op-nav-toggle"
        aria-hidden="true"
        tabIndex={-1}
      />
      <label htmlFor="op-nav-toggle" className="op-nav-button">
        <span aria-hidden="true">☰</span>
        <span>Menu</span>
      </label>
      <aside
        aria-label="Primary navigation"
        className="op-sidebar"
        style={{ borderRight: '1px solid var(--border)', padding: '1.5rem 1rem' }}
      >
        {/* BinGo Auctions wordmark — matches the company logo (white italic
            BinGo + orange growth arrow + cyan AUCTIONS). */}
        <Link
          href="/dashboard"
          style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: 5,
            textDecoration: 'none',
            marginBottom: '1.5rem',
            lineHeight: 1,
            fontFamily: 'var(--font-display), "Plus Jakarta Sans", sans-serif',
          }}
          aria-label="BinGo Auctions dashboard"
        >
          <span style={{ fontSize: 20, fontWeight: 800, fontStyle: 'italic', letterSpacing: -0.5, color: '#ffffff' }}>
            BinGo
          </span>
          <span aria-hidden style={{ color: 'var(--accent)', fontWeight: 900, fontSize: 15, transform: 'translateY(-1px)' }}>
            &#8599;
          </span>
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 2.5, textTransform: 'uppercase', color: 'var(--cyan)' }}>
            Auctions
          </span>
        </Link>
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)' }}>Operator</div>
          <div style={{ fontWeight: 600 }}>
            {(staff as unknown as { operators?: { business_name?: string } }).operators
              ?.business_name ?? 'Unknown'}
          </div>
        </div>
        <nav style={{ display: 'grid', gap: '0.15rem' }}>
          <Link href="/dashboard" style={navLinkStyle}>Dashboard</Link>
          {role === 'admin' && (
            <Link
              href="/dashboard/workers"
              style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
            >
              Worker productivity
            </Link>
          )}

          <NavSection label="Auctions" />
          <Link href="/auctions" style={navLinkStyle}>Auctions</Link>

          {/* Lotting parent: everything that creates / curates / cleans
              up lots before they hit the auction builder. /lots redirects
              here; /inventory redirects to /lotting/inventory. */}
          <NavSection label="Lotting" />
          <Link href="/lots/lookup" style={navLinkStyle}>Lot lookup</Link>
          <Link href="/lotting/inventory" style={navLinkStyle}>Inventory</Link>
          <Link href="/lotting/drafts" style={navLinkStyle}>Drafts</Link>
          {/* A manifest is reference data for stock that has not arrived: it
              lands in import_rows and a lot is born when somebody scans the
              physical item (mig 0059). That path had no nav entry at all,
              while Smart Import sat here labelled "Import" — so the only
              thing in the console called Import was the one tool that minted
              a lot per spreadsheet row. That is how 1,369 rows of product
              data became inventory on 2026-09-11 (0359, 0360). Smart Import
              is now retired; upload sits directly above the pool it fills,
              and migration keeps one entry below, named for what it does.
              Nothing here is labelled bare "Import" again.

              Role-gated to match the page, which is admin/manager only — as
              /imports/migrate's entry already was. Manifest pool below stays
              visible to everyone: bench staff read it, they don't upload it. */}
          {(role === 'admin' || role === 'manager') && (
            <Link href="/imports/new" style={navLinkStyle}>Import manifest</Link>
          )}
          <Link href="/lotting/manifest-pool" style={navLinkStyle}>Manifest pool</Link>
          <Link href="/lotting/catalog" style={navLinkStyle}>Catalog</Link>
          {(role === 'admin' || role === 'manager') && (
            /* The one-off: stock already on the shelves, already lotted
               somewhere else. It preserves the printed lot code verbatim so
               existing labels still scan, and it is not a way to load a
               manifest — that is the entry above. */
            <Link
              href="/imports/migrate"
              style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
            >
              Migrate from another platform
            </Link>
          )}
          {/* W9 slice 3: Loads — manager-tracked trucks/pallets. Visible
              to all staff (read-only enforced by RLS); only admin/manager
              see the create + archive buttons inside. */}
          <Link href="/loads" style={navLinkStyle}>Loads</Link>
          <Link href="/lottr" style={navLinkStyle}>AI Lotting</Link>

          <NavSection label="Warehouses" />
          <Link href="/warehouses" style={navLinkStyle}>Warehouses</Link>
          <Link
            href="/lotting/stickers"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Print blank QR stickers
          </Link>

          <NavSection label="Pickup & issues" />
          <Link href="/pickups" style={navLinkStyle}>Pickups</Link>
          <Link href="/disputes" style={navLinkStyle}>Disputes</Link>
          {/* In-app bug reports + suggestions from the bidder and staff apps
              (mig 0317). Sits next to Disputes because both are "someone told
              us something is wrong" — the difference is that a dispute is
              money-bearing and this isn't. */}
          <Link href="/feedback" style={navLinkStyle}>Feedback</Link>

          <NavSection label="Money" />
          <Link href="/invoices" style={navLinkStyle}>Invoices</Link>
          <Link href="/settlements" style={navLinkStyle}>Settlements</Link>

          <NavSection label="Bidders & reports" />
          <Link href="/bidders" style={navLinkStyle}>Bidders</Link>
          <Link href="/marketing" style={navLinkStyle}>Marketing</Link>
          <Link href="/reports" style={navLinkStyle}>Reports</Link>
          <Link
            href="/reports/money"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Money &amp; Square
          </Link>
          <Link
            href="/reports/bidders"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Bidders &amp; retention
          </Link>
          {/* Admin/manager only, like the function (mig 0434). */}
          {(role === 'admin' || role === 'manager') && (
            <Link
              href="/reports/bidder-zips"
              style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
            >
              Bidders by ZIP
            </Link>
          )}
          {/* Admin/manager only, like the functions (mig 0449). */}
          {(role === 'admin' || role === 'manager') && (
            <Link
              href="/reports/bidder-insights"
              style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
            >
              Bidder insights
            </Link>
          )}
          <Link
            href="/reports/auctions"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Auction performance
          </Link>
          <Link
            href="/reports/health"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Operations health
          </Link>
          <Link
            href="/reports/aging"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Aging inventory
          </Link>
          {/* Admin/manager only, like the page (mig 0381 RLS). */}
          {(role === 'admin' || role === 'manager') && (
            <Link
              href="/reports/kept"
              style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
            >
              Kept items
            </Link>
          )}
          {(role === 'admin' || role === 'manager') && (
            <Link
              href="/reports/refund-overrides"
              style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
            >
              Refund overrides
            </Link>
          )}
          <Link
            href="/reports/missing"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Missing items
          </Link>
          <Link
            href="/reports/duplicates"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Duplicate audit
          </Link>

          {showGrowthNav && (
            <>
              <NavSection label="Growth" />
              {GROWTH_NAV_GROUP.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  style={
                    item.sub
                      ? { ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }
                      : navLinkStyle
                  }
                >
                  {item.label}
                </Link>
              ))}
            </>
          )}

          <NavSection label="Org" />
          <Link href="/staff" style={navLinkStyle}>Staff</Link>
          <Link href="/settings" style={navLinkStyle}>Settings</Link>
          <Link
            href="/settings/policies"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Policies
          </Link>
          <Link
            href="/settings/bidder-experience"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Bidder experience
          </Link>
          <Link
            href="/settings/fulfillment"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Fulfillment
          </Link>

          <NavSection label="You" />
          <Link href="/account" style={navLinkStyle}>Account</Link>
          <Link
            href="/account/security"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Two-factor auth
          </Link>
          <Link
            href="/account/policies"
            style={{ ...navLinkStyle, paddingLeft: 16, fontSize: 13, color: 'var(--fg-muted)' }}
          >
            Bidder policies
          </Link>
          <SignOutLink
            style={{
              ...navLinkStyle,
              marginTop: '1rem',
              color: 'var(--fg-muted)',
              textDecoration: 'none',
              display: 'inline-block',
            }}
          />
        </nav>
      </aside>
      <main id="main-content" style={{ padding: '2rem' }}>
        {/* Renders nothing until the deployed build changes underneath this
            tab. `pageBuild` is resolved HERE, on the server, so the value
            baked into the HTML is exactly the build whose chunk URLs this tab
            is holding — which is the thing that goes stale. Reading it in the
            client instead would compare the current build against itself and
            never fire. Above MfaSetupBanner because a console that is about to
            stop responding outranks a 7-day MFA nudge. */}
        <BuildSkewNotice pageBuild={currentBuildId()} />
        {showMfaBanner && adminFirstSeenAt && (
          <MfaSetupBanner userId={user.id} adminFirstSeenAt={adminFirstSeenAt} />
        )}
        {children}
      </main>
      <ConsoleUiToggle v2={consoleV2} />
    </div>
  );
}
