/**
 * Public (bidder-facing) layout — wraps every page under /auctions, /lots, /l.
 *
 * 2026-05-22: web-first bidder experience. Nav now offers Sign up + Sign in
 * for anon visitors and Profile + Watchlist for signed-in bidders.
 * "Get the app" moved to a secondary footer link — the web is first-class
 * now, and the App Store install is a power-user option, not the primary
 * CTA.
 *
 * Why a separate route group:
 *   - Middleware whitelists /auctions, /lots, /l for anonymous access.
 *     Putting them in (public)/ makes the intent visible at the file level.
 *   - The operator (operator)/layout.tsx requires an `operator_users` row.
 *     Bidders don't have one, so they cannot live under that subtree.
 *
 * Auth state in the nav:
 *   - Anonymous: Auctions, Sign in, Sign up (primary CTA).
 *   - Signed-in bidder: Auctions, Profile, Sign out is reachable from
 *     /profile. We also surface their email/display name as a quiet
 *     identity chip.
 *   - Signed-in operator: same bidder nav plus an "Operator console" link
 *     back to /dashboard (some humans wear both hats).
 */

import Link from 'next/link';
import Image from 'next/image';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { finishProfileRedirect, nextPathFromRequest } from '@/lib/bidder-onboarding-gate';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { CityPicker } from '../home-client';
import { CategoryMegaMenuWithGroups, loadCategoryGroups } from './_components/CategoryMegaMenu';
import { hoursLines } from '@/lib/warehouse-pickup';
import { SearchBar } from './_components/SearchBar';
import { MobileNavControls } from './_components/MobileNavControls';
import { AccountMenu } from './_components/AccountMenu';
import { MetaPixel } from './_components/MetaPixel';
import { MetaAttribution } from './_components/MetaAttribution';
import { getFinalCallCount } from './final-call/live-count';
import { loadPrimaryBusiness } from '@/lib/seo';
import { getDemoOperatorIds, demoExclusionList } from '@/lib/demo-operators';
import type { CategoryGroup } from './_components/CategoryMegaMenu';

const MAX_W = 1100;

// Cities offered by the nav location picker.
//
// Derived from auctions a shopper can actually reach — scheduled/live, listed,
// non-demo — rather than from the warehouse table. Two bugs came out of the
// old "every active operator's warehouse city" query (owner report 2026-08-26):
//
//   * "Demo City" was offered as a BinGo location. The demo operator is
//     `status='active'` with onboarding complete, so it passed the filter.
//     Every other storefront surface excludes demo operators via
//     demoExclusionList(); this one never did.
//   * Cities with nothing to buy were listed (Springdale has 0 auctions), so
//     picking one could only ever show an empty store.
//
// A shopper who picks a city and sees nothing assumes the site is broken; a
// shopper offered a city that isn't ours has already lost trust.
async function loadCities(): Promise<string[]> {
  try {
    const supabase = getSupabaseAdmin();
    const demoExclude = demoExclusionList(await getDemoOperatorIds());

    let q = supabase
      .from('auctions')
      .select('warehouses!inner(city)')
      .in('status', ['scheduled', 'live'])
      .eq('unlisted', false);
    if (demoExclude) q = q.not('operator_id', 'in', demoExclude);
    const { data } = await q;

    const set = new Set<string>();
    for (const row of (data ?? []) as Array<{
      warehouses: { city: string | null } | { city: string | null }[] | null;
    }>) {
      const wh = Array.isArray(row.warehouses) ? row.warehouses[0] : row.warehouses;
      const city = wh?.city?.trim();
      if (city) set.add(city);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Decide which secondary nav action to surface for signed-in users, and
  // close the #727 dead end: a signed-in auth account with no `bidders` row
  // used to be able to browse the public marketplace forever without ever
  // being sent to finish their profile. Only the profile/pickup/invoice pages
  // (and the native app) guarded that, so an orphan who never opened one of
  // them could never bid and never saw why. Send them to onboarding first,
  // and carry their destination so they land back here afterwards.
  //
  // A lookup ERROR never counts as "no profile": a warehouse wifi blip must
  // not bounce an established bidder out of the marketplace, and a staff
  // lookup blip must not mistake staff for a bidder orphan.
  let isOperator = false;
  if (user) {
    const [staffRes, bidderRes] = await Promise.all([
      supabase
        .from('operator_users')
        .select('user_id')
        .eq('user_id', user.id)
        .maybeSingle(),
      supabase.from('bidders').select('id').eq('id', user.id).maybeSingle(),
    ]);
    isOperator = !!staffRes.data;

    const h = await headers();
    const target = finishProfileRedirect(
      {
        signedIn: true,
        isOperator,
        hasBidderRow: !!bidderRes.data,
        bidderLookupFailed: !!bidderRes.error,
        staffLookupFailed: !!staffRes.error,
      },
      nextPathFromRequest(h.get('x-pathname'), h.get('x-search')),
    );
    if (target) redirect(target);
  }

  // Pull cities, Final Call count, and category groups in parallel.
  // Groups are passed to both the desktop CategoryMegaMenu and MobileNavControls
  // so we avoid two separate DB round-trips for the same category tree.
  const [cities, finalCallCount, categoryGroups] = await Promise.all([
    loadCities(),
    getFinalCallCount(),
    loadCategoryGroups(),
  ]);

  return (
    <div style={{ background: 'var(--bg)', color: 'var(--fg)', minHeight: '100vh' }}>
      <PublicNav
        signedInEmail={user?.email ?? null}
        isOperator={isOperator}
        cities={cities}
        finalCallCount={finalCallCount}
        categoryGroups={categoryGroups}
      />
      <main>{children}</main>
      <PublicFooter />
      {/* Storefront only — never the operator console (see MetaPixel). Live;
          gated per visitor by the advertising opt-out, not by config. */}
      <MetaPixel />
      {/* Ships _fbp/_fbc to our own server so the Conversions API can credit
          the ad click that produced a sale (0341). Renders nothing. */}
      <MetaAttribution />
    </div>
  );
}

async function PublicNav({
  signedInEmail,
  isOperator,
  cities,
  finalCallCount,
  categoryGroups,
}: {
  signedInEmail: string | null;
  isOperator: boolean;
  cities: string[];
  /** Number of lots currently inside the 2-min Final Call window. When zero
   *  the nav link still renders, but dimmed + no pulsing dot. */
  finalCallCount: number;
  categoryGroups: CategoryGroup[];
}) {
  const finalCallActive = finalCallCount > 0;
  return (
    <header
      className="public-nav-header"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'rgba(21, 35, 58, 0.9)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
        // Horizontal padding is media-query controlled (see <style> at the
        // bottom of this component): 12px under 480px, 24px above. The
        // 24px default was overflowing the iPhone 14 (390px) viewport
        // because the auth nav at the right is flexShrink: 0 and can't
        // give up space — measured 413px scrollWidth in the audit-fixes
        // e2e (threshold 400).
      }}
    >
      <div
        className="public-nav-inner"
        style={{
          maxWidth: MAX_W,
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          height: 56,
        }}
      >
        {/* ── Logo ── */}
        <Link
          href="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            textDecoration: 'none',
            flexShrink: 0,
          }}
          aria-label="BinGo Auctions home"
        >
          {/* BinGo Auctions wordmark — matches the company logo: white italic
              "BinGo" + the orange up-right growth arrow + cyan "AUCTIONS".
              CSS lockup (scales in the nav; the square logo asset lives at
              /bingo-logo.jpg for favicon/OG/app icons). */}
          <span
            aria-label="BinGo Auctions"
            className="public-nav-wordmark"
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 5,
              lineHeight: 1,
              fontFamily: 'var(--font-display), "Plus Jakarta Sans", system-ui, sans-serif',
            }}
          >
            <span
              style={{
                fontSize: 23,
                fontWeight: 800,
                fontStyle: 'italic',
                letterSpacing: -0.5,
                color: '#ffffff',
              }}
            >
              BinGo
            </span>
            <span
              aria-hidden
              className="public-nav-wordmark-tail"
              style={{
                color: 'var(--accent)',
                fontWeight: 900,
                fontSize: 17,
                transform: 'translateY(-1px)',
              }}
            >
              &#8599;
            </span>
            <span
              className="public-nav-wordmark-tail"
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 3,
                textTransform: 'uppercase',
                color: 'var(--cyan)',
              }}
            >
              Auctions
            </span>
          </span>
        </Link>

        {/* ── Mobile-only: hamburger (opens category drawer) + search icon ── */}
        {/* Visible <768px; hidden ≥768px via CSS class below. */}
        <MobileNavControls categoryGroups={categoryGroups} finalCallCount={finalCallCount} />

        {/* ── All categories mega-menu (desktop: inline; mobile: inside hamburger) ── */}
        <div className="public-nav-mega">
          <CategoryMegaMenuWithGroups groups={categoryGroups} />
        </div>

        {/* ── Search bar (grows to fill available space) ── */}
        <div className="public-nav-search" style={{ flex: 1, minWidth: 0 }}>
          <SearchBar />
        </div>

        {/* ── City picker (desktop only) ── */}
        {cities.length > 0 && (
          <div className="public-nav-cities">
            <CityPicker cities={cities} />
          </div>
        )}

        {/* ── Auth links ── */}
        <nav
          className="public-nav-auth"
          style={{
            display: 'flex',
            // Gap is media-query controlled (see <style> below): 0.5rem
            // under 480px, 1rem above. Tightening at mobile reclaims ~16px
            // for the iPhone 14 viewport without removing any link.
            alignItems: 'center',
            fontSize: 14,
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          <span className="public-nav-browse-link">
            {/* WEB-01: ?view=auctions is required. Bare /browse is the
                lots firehose, so this link promised auctions and delivered
                a lot grid. See browse/page.tsx isLotsMode. */}
            <NavLink href="/browse?view=auctions">Auctions</NavLink>
          </span>

          {/* Final Call — desktop-only urgent CTA. Dimmed when count is 0. */}
          <span className="public-nav-final-call">
            <Link
              href="/final-call?from=nav"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--urgent-red)',
                textDecoration: 'none',
                fontWeight: 800,
                letterSpacing: 0.3,
                opacity: finalCallActive ? 1 : 0.45,
              }}
              aria-label={
                finalCallActive
                  ? `Final Call — ${finalCallCount} lots closing in under 2 minutes`
                  : 'Final Call — no lots in the rush right now'
              }
            >
              {finalCallActive && (
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--urgent-red)',
                    animation:
                      'final-call-nav-pulse 1.5s ease-in-out infinite',
                  }}
                />
              )}
              Final Call
            </Link>
          </span>

          {signedInEmail ? (
            /* WEB-NAV: compact dropdown under one trigger — Watch List /
               Winning / My Bids / Past wins / Pickup / Receipts (+ Operator
               console). One button keeps the nav inside the 390px budget
               instead of N always-on links. */
            <AccountMenu isOperator={isOperator} />
          ) : (
            <>
              <Link
                href="/login"
                style={{ color: 'var(--fg-muted)', textDecoration: 'none' }}
                className="public-nav-signin"
              >
                Sign in
              </Link>
              <Link href="/signup" className="btn-primary" style={btnSmall}>
                Sign up
              </Link>
            </>
          )}
        </nav>
      </div>

      <style>{`
        /* Mobile-first: hide elements that need space, slim the chrome so
           the iPhone-14 viewport (390px) doesn't overflow. */
        .public-nav-header  { padding: 0 0.75rem; }
        .public-nav-auth    { gap: 0.5rem; }
        .public-nav-mega    { display: none; }
        .public-nav-search  { display: none; flex: 1; min-width: 0; }
        /* The location picker stays visible at every width. It used to be
           display:none below 768px, so on a phone in portrait it simply did
           not exist — a customer had to rotate to landscape or request the
           desktop site to find it (owner report 2026-08-26). Buying from the
           wrong warehouse is a refund and a wasted trip, which makes this the
           one nav control that must never be the thing we drop for space. */
        .public-nav-cities  { display: flex; min-width: 0; flex: 0 1 auto; }
        /* The picker is a native <select>, which sizes itself to its WIDEST
           option -- so its width is set by the longest warehouse city name,
           not by anything in this file. That is why it cannot be budgeted for
           in pixels: adding a warehouse called "Fayetteville" would silently
           re-break the row. Letting it shrink instead (min-width:0 above,
           max-width here) makes overflow structurally impossible; the label
           truncates rather than the page scrolling sideways. */
        .public-nav-cities select {
          max-width: 100%;
          min-width: 0;
          text-overflow: ellipsis;
          padding-left: 0.7rem;
          padding-right: 1.6rem;
          background-position: right 0.55rem center;
        }
        /* "Auctions" is hidden below 480px, not just above 768px. On a phone
           it is redundant three ways over: the hamburger opens the full
           category menu, the wordmark goes home, and the hero's own "Browse
           Auctions" button is the primary CTA. It is the cheapest ~70px in
           the row and the only one whose removal costs no capability -- the
           search icon and the Final Call timer are each the sole mobile entry
           point to their feature. Visible in the 480-768px band, where there
           is room and no mega-menu yet. */
        .public-nav-browse-link { display: none; }
        .public-nav-final-call { display: none; }
        /* <480px: "Sign in" text link hidden — signed-out row (wordmark +
           Final Call/hamburger/search icons + Auctions + Sign in + Sign up)
           measured 417px on the 390px iPhone-14 viewport even with the
           Final Call label collapsed to its icon (audit-fixes e2e, threshold
           400, 2026-07-07). Returning users reach sign-in via Sign up →
           "Already have an account? Sign in"; signed-in users get the
           AccountMenu and never see this link. */
        .public-nav-signin  { display: none; }
        /* W1+W2: mobile icon controls — visible on phones, hidden once desktop
           items take over at their respective breakpoints. */
        .public-nav-mobile-controls { display: flex; align-items: center; gap: 0.25rem; }
        /* Narrow phones (<480px): keep the italic "BinGo" word as the home
           link but drop the "↗ AUCTIONS" tail. The nav row is wordmark +
           hamburger/search icons + auth links, all flexShrink:0 — with the
           full lockup it lands at 488px on a 390px viewport (audit-fixes
           e2e "no horizontal scroll", threshold 400; measured live
           2026-07-02: tail-hidden = exactly 390). NOTE: the hide must live
           on the tail spans, not .public-nav-wordmark — the wordmark span
           carries an inline display:'inline-flex' that beats any class rule
           (that inline style is how the rebrand regressed the original
           hide-the-wordmark fix). */
        .public-nav-wordmark-tail { display: none; }
        /* Final Call in the mobile icon row: timer glyph only under 480px —
           the text label costs ~48px and blew the 390px viewport to 438px
           scrollWidth (audit-fixes e2e, threshold 400, failed 2026-07-07).
           The label returns at 480px where there's room. */
        .public-nav-mobile-fc-label { display: none; }

        @media (min-width: 480px) {
          .public-nav-header { padding: 0 1.5rem; }
          .public-nav-auth   { gap: 1rem; }
          .public-nav-wordmark-tail { display: inline; }
          .public-nav-mobile-fc-icon  { display: none; }
          .public-nav-mobile-fc-label { display: inline; }
          .public-nav-signin { display: inline; }
          .public-nav-browse-link { display: flex; }
          .public-nav-cities select {
            padding-left: 0.95rem;
            padding-right: 2rem;
            background-position: right 0.7rem center;
          }
        }

        @media (min-width: 640px) {
          .public-nav-search { display: flex; }
          /* Search icon no longer needed once bar is visible */
          .public-nav-mobile-search-btn { display: none; }
        }

        @media (min-width: 768px) {
          .public-nav-mega    { display: flex; }
          .public-nav-browse-link { display: none; }
          .public-nav-final-call { display: inline-flex; }
          /* Hamburger no longer needed once mega-menu is visible */
          .public-nav-mobile-controls { display: none; }
        }

        @keyframes final-call-nav-pulse {
          0% { opacity: 1; }
          50% { opacity: 0.4; }
          100% { opacity: 1; }
        }
      `}</style>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} style={{ color: 'var(--fg-muted)', textDecoration: 'none' }}>
      {children}
    </Link>
  );
}

const btnSmall: React.CSSProperties = { padding: '0.45rem 1rem', fontSize: 13 };

async function PublicFooter() {
  // Visible NAP (name/address) block — the JSON-LD carries this for
  // crawlers, but humans asked "where ARE you?" (owner, 2026-07-06).
  const biz = await loadPrimaryBusiness();
  const addr = biz?.address ?? null;
  const mapsUrl = addr
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        [addr.line1, addr.line2, addr.city, addr.state, addr.postalCode]
          .filter(Boolean)
          .join(', '),
      )}`
    : null;
  const hours = hoursLines(biz?.pickupHours ?? null);

  return (
    <footer
      style={{
        borderTop: '1px solid var(--border)',
        padding: '3rem 1.5rem 2rem',
        background: 'var(--bg)',
        marginTop: '4rem',
      }}
    >
      <div
        style={{
          maxWidth: MAX_W,
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '2rem',
          marginBottom: '2.5rem',
        }}
      >
        <div>
          <div style={{ fontWeight: 900, fontSize: '1.05rem', marginBottom: 8 }}>BinGo Auctions</div>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
            Online auctions,
            <br />
            run by the people who run them.
          </div>
        </div>

        <div>
          <div style={footerHeading}>Browse</div>
          {/* WEB-01: same as the nav link — "Live auctions" must land on
              the auctions view, not the default lots firehose. */}
          <FooterLink href="/browse?view=auctions">Live auctions</FooterLink>
          <FooterLink href="/how-it-works">How it works</FooterLink>
          <FooterLink href="/signup">Sign up</FooterLink>
          <FooterLink href="/login">Sign in</FooterLink>
        </div>

        <div>
          <div style={footerHeading}>Support</div>
          <FooterLink href="/support">Help &amp; Support</FooterLink>
          <FooterLink href="/download">Get the app</FooterLink>
          <FooterLink href="mailto:support@bingoauctions.com">support@bingoauctions.com</FooterLink>
        </div>

        <div>
          <div style={footerHeading}>Legal</div>
          <FooterLink href="/legal/terms">Terms</FooterLink>
          <FooterLink href="/legal/privacy">Privacy</FooterLink>
          {/* California requires the "do not sell or share" control to be
              conspicuous, which a link only inside the policy text is not. */}
          <FooterLink href="/privacy-choices">Your privacy choices</FooterLink>
          <FooterLink href="/legal/bidder-agreement">Bidder Agreement</FooterLink>
        </div>

        {addr && (
          <div>
            <div style={footerHeading}>Visit us</div>
            <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
              {addr.line1}
              {addr.line2 ? (
                <>
                  <br />
                  {addr.line2}
                </>
              ) : null}
              <br />
              {addr.city}, {addr.state} {addr.postalCode}
            </div>
            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'block',
                  color: 'var(--accent)',
                  textDecoration: 'none',
                  fontSize: 13,
                  padding: '0.3rem 0',
                }}
              >
                Get directions ↗
              </a>
            )}
            {hours.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--fg-dim)', lineHeight: 1.6, marginTop: 4 }}>
                <div style={{ fontWeight: 700 }}>Pickup hours</div>
                {hours.map((h) => (
                  <div key={h}>{h}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          maxWidth: MAX_W,
          margin: '0 auto',
          paddingTop: '1.5rem',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.5rem',
          fontSize: 12,
          color: 'var(--fg-dim)',
        }}
      >
        <span>&copy; 2026 BinGo Auctions. All rights reserved.</span>
        <span>US-only service</span>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      style={{
        display: 'block',
        color: 'var(--fg-muted)',
        textDecoration: 'none',
        fontSize: 13,
        padding: '0.3rem 0',
      }}
    >
      {children}
    </Link>
  );
}

const footerHeading: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 2,
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
  marginBottom: '0.75rem',
};
