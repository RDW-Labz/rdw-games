// Next.js middleware — refreshes the Supabase session cookie on every request,
// so server components see fresh auth state. Also redirects unauthenticated
// users away from operator routes to /login.
//
// SINGLE-DOMAIN (BinGo): one Next.js app, one domain, serving BOTH the
// public bidder marketplace (/(public)/*) AND the operator console
// (/(operator)/*). The prior multi-tenant build split these across
// bingoauctions.com and operators.bingoauctions.com with host-aware rewrites/redirects;
// as a single auction house there is one host, so that machinery is gone.
//
// IMPORTANT: Next.js route GROUPS (folder names like `(operator)`) never
// appear in the URL. We use a positive-list of public route prefixes and
// redirect everything else that maps to a known operator-console route;
// unknown paths fall through to the branded 404.
//
// MFA step-up enforcement: for operator admins with a verified TOTP factor
// whose current session is at AAL1, sensitive routes (staff, billing,
// account, payouts) are gated behind AAL2 (redirect to
// /account/security/step-up?returnTo=). Non-sensitive routes stay at AAL1.
//
// Why middleware vs. per-page: a single chokepoint is easier to audit and
// can't be forgotten when adding new pages. API routes don't pass through
// this middleware (the matcher excludes /api); sensitive API mutations
// re-check AAL inside the route handler — see lib/require-aal2.ts.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { isGrowthHubConsoleRoute, isGrowthHubEnabled } from './lib/growth-hub';

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Routes that don't require a Supabase session. Everything else needs auth.
// Note: API routes are excluded from middleware via the `matcher` below
// because they do their own auth checks (and webhooks must run unauth'd).
const PUBLIC_ROUTE_PREFIXES = [
  '/login',
  '/signup',
  '/forgot-password',  // request a reset email
  '/reset-password',   // landing page from the reset email
  // NOTE: /qr is dev-only (hardcoded LAN IP) and intentionally NOT public.
  '/auth',           // /auth/callback for OAuth + email-confirm redirects
  '/legal',          // public Terms / Privacy / Bidder agreement
  '/support',        // public support contact page (App Store requires)
  // CCPA "do not sell or share" control. MUST be reachable signed-out: an
  // opt-out gated behind a login would require identifying yourself in order
  // to be tracked less, which is the opposite of the point.
  '/privacy-choices',
  '/how-it-works',   // marketing pages — App Store reviewers + public
  '/download',
  // Bidder onboarding subtree — DOB + consent then card save. Gated inside
  // the page, but whitelisted here so middleware doesn't bounce freshly
  // signed-up users to /login before their cookie syncs.
  '/bidder',
  // ── Public bidder-facing routes ────────────────────────────────────────
  // Visitors who scan a lot QR or share a lot link land here without /login.
  // Pages render anonymously; the bid CTA gates itself.
  '/browse',         // bidder-facing auction marketplace list
  '/auction',        // public auction detail (singular — /auctions is the
                     // operator console)
  '/.well-known',    // Apple App Site Association (Universal Links) etc.
  '/lot',            // canonical public lot detail SEO URL (singular)
  '/l',              // /l/{qr_token} short-link → 302 to /lot/[lot_code]
  '/preview',        // /preview/{auction_id} door "Preview QR"
  '/sitemap.xml',
  '/robots.txt',
];

const PUBLIC_EXACT_PATHS = new Set<string>([
  '/',
]);

// Routes that REQUIRE AAL2 for users who have a verified TOTP factor.
// The /account/security subtree is OMITTED so a user at AAL1 can still
// reach the enrollment + step-up pages — otherwise they could never elevate.
const SENSITIVE_ROUTE_PREFIXES = [
  '/staff',
  '/billing',
  '/account',
  '/payouts',
];

const STEP_UP_EXEMPT_PREFIXES = [
  '/account/security',
];

function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_EXACT_PATHS.has(pathname)) return true;
  for (const prefix of PUBLIC_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return true;
  }
  return false;
}

function isSensitiveRoute(pathname: string): boolean {
  for (const exempt of STEP_UP_EXEMPT_PREFIXES) {
    if (pathname === exempt || pathname.startsWith(exempt + '/')) return false;
  }
  for (const prefix of SENSITIVE_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return true;
  }
  return false;
}

// Positive list of operator-console route prefixes. Used to decide whether an
// UNKNOWN path (no session) should redirect to /login (operator-console hit)
// or fall through to Next.js's not-found.tsx (random typo / dead link).
const OPERATOR_CONSOLE_PREFIXES = [
  '/dashboard',
  '/auctions',         // operator console (plural; bidder detail is /auction)
  '/lots',             // operator inventory
  '/inventory',
  '/staff',
  '/account',
  '/settings',
  '/warehouses',
  '/disputes',
  '/lotting',
  '/lottr',
  '/imports',
  '/loads',
  '/pickups',
  '/reports',
  '/settlements',
  '/invoices',
  '/bidders',
  '/shipping',
  '/ops',
  '/worklist',
  '/identity',
];

function isOperatorConsoleRoute(pathname: string): boolean {
  for (const prefix of OPERATOR_CONSOLE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return true;
  }
  return false;
}

export async function middleware(req: NextRequest) {
  // Expose the current pathname to Server Components via a request header.
  // The operator layout uses this to know if we're on the rotate-password
  // page (exempt from the force-rotate redirect loop).
  //
  // `x-search` carries the query string separately so the finish-profile gate
  // can return a visitor to the exact view/city/search/page they left, while
  // existing pathname-only consumers keep seeing a bare pathname. Both are
  // overwritten from the request URL, never trusted from the incoming request.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', req.nextUrl.pathname);
  requestHeaders.set('x-search', req.nextUrl.search);

  const res = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }: CookieToSet) =>
            req.cookies.set(name, value),
          );
          cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
            res.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublicRoute(req.nextUrl.pathname)) {
    // Known operator-console route → force login. Unknown path → fall
    // through to Next's not-found.tsx so the branded 404 is reachable
    // for anonymous visitors.
    if (
      isOperatorConsoleRoute(req.nextUrl.pathname) ||
      isGrowthHubConsoleRoute(req.nextUrl.pathname, isGrowthHubEnabled())
    ) {
      const loginUrl = new URL('/login', req.url);
      loginUrl.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
    // Unknown path + anonymous → fall through to 404.
  }

  // ── AAL2 enforcement ────────────────────────────────────────────────
  // Only when: the user is signed in, the path is a sensitive operator
  // route, AND the user is an operator admin with a verified TOTP factor.
  if (user && isSensitiveRoute(req.nextUrl.pathname)) {
    const { data: staff } = await supabase
      .from('operator_users')
      .select('role')
      .eq('user_id', user.id)
      .maybeSingle();
    const role = (staff as { role?: string } | null)?.role ?? null;

    if (role === 'admin') {
      const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      const current = aalData?.currentLevel ?? null;

      if (current !== 'aal2') {
        const { data: factorsData } = await supabase.auth.mfa.listFactors();
        const hasVerifiedTotp = (factorsData?.all ?? []).some(
          (f) => f.factor_type === 'totp' && f.status === 'verified',
        );

        if (hasVerifiedTotp) {
          const stepUpUrl = new URL('/account/security/step-up', req.url);
          stepUpUrl.searchParams.set(
            'returnTo',
            req.nextUrl.pathname + req.nextUrl.search,
          );
          return NextResponse.redirect(stepUpUrl);
        }
      }
    }
  }

  return res;
}

export const config = {
  // Skip _next assets, static images, AND /api/* — API routes do their own
  // auth checks and webhooks (Stripe) must accept unauthenticated requests.
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
