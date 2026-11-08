// Profile screen — v3 4-card rebuild.
//
// 2026-05-24 (Sprint 1 OTA v1.0.1): mirrors the browser bidder profile
// (apps/operator-web/src/app/(public)/profile/page.tsx) — header with v3
// brand mark + display name + email, then four navigation cards
// (Payment / Receipts / Watchlist / My bids), the new My Stats card,
// and a ghost-styled Sign out at the bottom.
//
// Replaces the previous flat list of three generic Pressable links
// (Edit profile / Saved searches / Subscription) which the user flagged
// as not reading as actionable. The 4-card layout pulled from the web
// version is the source of truth — it answers "what do bidders touch on
// this screen?" in one glance.
//
// Empty-state copy is intentionally encouraging not nagging. We're
// mirroring the web's "No card on file. You'll need one to bid." rather
// than scolding users into compliance.
//
// Data model: each card lazy-loads its own count/status from Supabase
// via the bidder's RLS-scoped client. There's no aggregate "/profile"
// RPC here — every read is a tiny independent query the page-cache can
// resolve in parallel. Loading state per-card so a single slow query
// doesn't block the rest of the screen.
//
// Constraints preserved from the prior file:
//   - Sign out handler is exact same Supabase call + router.replace('/').
//   - Account deletion link is kept at the bottom (Apple 5.1.1(v) compliance).
//   - Staff-role banner is kept (rare but real — operator users who
//     also bid land here).

import { useCallback, useEffect, useState } from 'react';
import { Alert, View, Text, Pressable, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { Link, router, useFocusEffect } from 'expo-router';
import {
  supabase,
  useRole,
} from '@auction-platform/supabase-client';
import { BrandedButton, colors } from '@auction-platform/design-system';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { LoyaltyCard } from '../../components/LoyaltyCard';
import { PromoCodeCard } from '../../components/PromoCodeCard';

// BinGo brand mark — bundled locally (the app icon), no remote CDN dependency.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

const BRAND_ICON = require('../../assets/icon.png');

// Card surface — design tokens don't expose `bg-surface` yet; using the
// hex literal that matches the rest of the v3 dark UI (see HomeHero,
// SectionBanner, my-bids row backgrounds).
const CARD_BG = '#1A1D24';
const CARD_BORDER = '#232839';
const SCREEN_BG = colors.bg;
const TEXT_PRIMARY = '#e8eaf0';
const TEXT_MUTED = '#8a93a6';
const BRAND_GREEN = '#5FE065';

interface ProfileSummary {
  displayName: string | null;
  email: string | null;
  bidderNumber: number | null;
  hasCard: boolean;
  watchlistCount: number;
  recentBidsCount: number;
  loading: boolean;
}

// Initial load runs every focus pass. A bidder navigating away to add a
// card and back should see the card-on-file state update without a hard
// refresh.
async function loadProfileSummary(): Promise<ProfileSummary | null> {
  const { data: u } = await supabase.auth.getUser();
  const user = u.user;
  if (!user) return null;

  const bidderId = user.id;

  // RLS scopes each of these to the caller (bidder_id = auth.uid()), so
  // no extra filters needed beyond column projection.
  const [
    bidderQ,
    watchlistQ,
    bidsQ,
  ] = await Promise.all([
    supabase
      .from('bidders')
      // bidder_number (mig 0254): the customer's permanent paddle number.
      // Shown so they can identify themselves when calling / at the counter
      // (support-ask 2026-07-17). Column is absent from the generated types,
      // so the row is cast locally below.
      .select('display_name, email, default_payment_method_id, bidder_number')
      .eq('id', bidderId)
      .maybeSingle(),
    supabase
      .from('watchlist')
      .select('lot_id', { count: 'exact', head: true })
      .eq('bidder_id', bidderId),
    supabase
      .from('bids')
      .select('lot_id', { count: 'exact', head: true })
      .eq('bidder_id', bidderId)
      .eq('is_auto', false)
      .gte(
        'placed_at',
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      ),
  ]);

  const bidder = bidderQ.data as
    | {
        display_name: string | null;
        email: string | null;
        default_payment_method_id: string | null;
        bidder_number: number | null;
      }
    | null;

  return {
    displayName: bidder?.display_name ?? null,
    email: bidder?.email ?? user.email ?? null,
    bidderNumber: bidder?.bidder_number ?? null,
    hasCard: !!bidder?.default_payment_method_id,
    watchlistCount: watchlistQ.count ?? 0,
    recentBidsCount: bidsQ.count ?? 0,
    loading: false,
  };
}

// Default export wraps the screen body in an ErrorBoundary so a
// render-time throw (e.g. malformed RLS row, undefined deref, missing
// design-token import) lands on a copyable error screen instead of
// silently killing the JS bundle. The inner component holds all the
// data/effect logic — the wrapper is intentionally trivial so the
// boundary can never itself throw.
export default function ProfileScreen() {
  return (
    <ErrorBoundary label="Profile tab">
      <ProfileScreenInner />
    </ErrorBoundary>
  );
}

function ProfileScreenInner() {
  const role = useRole();
  const [summary, setSummary] = useState<ProfileSummary>({
    displayName: null,
    email: null,
    bidderNumber: null,
    hasCard: false,
    watchlistCount: 0,
    recentBidsCount: 0,
    loading: true,
  });

  const load = useCallback(async () => {
    const next = await loadProfileSummary();
    if (next) setSummary(next);
    else setSummary((s) => ({ ...s, loading: false }));
  }, []);

  // Initial mount. useEffect (not useFocusEffect) so the very first
  // render kicks the query without waiting for the tab-focus event.
  useEffect(() => {
    load();
  }, [load]);

  // Refetch on focus — bidders who add a card or watch a new lot expect
  // the counts to be fresh when they come back to Profile.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const handleSignOut = useCallback(async () => {
    // scope:'local' — this device only; global sign-out revokes every
    // device's refresh token on the account (kills other signed-in devices).
    await supabase.auth.signOut({ scope: 'local' });
    router.replace('/');
  }, []);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: SCREEN_BG }}
      contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
    >
      {/* Header — brand mark + display name + email. The v3 icon ties
          the in-app experience to the splash/launch screen so the brand
          mark isn't only seen on app open. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          marginBottom: 24,
        }}
      >
        <Image
          source={BRAND_ICON}
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: CARD_BG,
          }}
          contentFit="cover"
          transition={150}
          cachePolicy="memory-disk"
        />
        <View style={{ flex: 1 }}>
          <Text
            style={{
              color: TEXT_PRIMARY,
              fontSize: 20,
              fontWeight: '800',
              letterSpacing: -0.3,
            }}
            numberOfLines={1}
          >
            {summary.displayName ?? summary.email ?? 'Bidder'}
          </Text>
          {summary.email && (
            <Text
              style={{
                color: TEXT_MUTED,
                fontSize: 13,
                marginTop: 2,
              }}
              numberOfLines={1}
            >
              {summary.email}
            </Text>
          )}
          {/* Permanent bidder/paddle number (mig 0254). Surfaced so a
              customer can identify themselves when calling or at the counter
              (support-ask 2026-07-17: "someone can see Bidder #369 is high
              bidder, but #369 has no way to know that's them"). */}
          {summary.bidderNumber != null && (
            <Text
              style={{
                color: BRAND_GREEN,
                fontSize: 14,
                fontWeight: '800',
                marginTop: 4,
                letterSpacing: 0.2,
              }}
            >
              Bidder #{summary.bidderNumber}
            </Text>
          )}
        </View>
      </View>

      {/* Staff banner — operator users who somehow landed in the bidder
          app see a hint that picker workflows live in BinGo Staff.
          Kept verbatim from the previous version. */}
      {role.ready && role.role !== 'bidder' && role.role !== 'unknown' && (
        <View
          style={{
            padding: 14,
            borderColor: '#2a3040',
            borderWidth: 1,
            borderRadius: 8,
            marginBottom: 16,
            backgroundColor: 'rgba(255, 122, 0, 0.08)',
          }}
        >
          <Text
            style={{
              color: BRAND_GREEN,
              fontSize: 11,
              fontWeight: '700',
              letterSpacing: 0.6,
            }}
          >
            STAFF ROLE: {role.role.toUpperCase()}
          </Text>
          <Text
            style={{
              color: TEXT_MUTED,
              marginTop: 4,
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            Picker workflows now live in the BinGo Staff app. Ask your
            operator admin for access to scan intake and staging.
          </Text>
        </View>
      )}

      {/* Payment method — primary CTA when no card; otherwise a row
          summarizing the saved card. Mirrors web's bidder /profile
          first card. Without a card on file place_bid() refuses any
          bid (migration 0105), so this is the highest-priority CTA. */}
      <PaymentMethodCard hasCard={summary.hasCard} loading={summary.loading} />

      {/* Loyalty points (2026-07-07) — the web profile has shown the shared
          Square Loyalty balance since mig 0237, but this app never grew the
          card, so points earned at the store registers were invisible here
          (customer report). Live balance + tier redemption via the existing
          /api/bidder/loyalty endpoints; hides itself when the feature is
          off. */}
      <LoyaltyCard />

      {/* Promo code (mig 0268) — bidder types a marketing code (e.g. BINS5);
          its value is minted as credit that the auto-charge applies to their
          next invoice. Server enforces eligibility/expiry/one-per-account. */}
      <PromoCodeCard />

      {/* Receipts — list of past invoices. Dedicated /profile/invoices
          screen landed 2026-06-01 (PR-3) after user reported tapping
          here routed to My Bids and surfaced "invoice not found" during
          the 30s build_invoice_jobs debounce window. The new screen
          mirrors the bidder-web /profile/invoices page. */}
      <NavCard
        title="Receipts"
        body="View invoices and receipts"
        chevron
        onPress={() => router.push('/profile/invoices' as never)}
      />

      {/* Watchlist — count when non-zero, encouraging copy when zero. */}
      <NavCard
        title="Watchlist"
        body={
          summary.loading
            ? 'Loading…'
            : summary.watchlistCount > 0
              ? `${summary.watchlistCount} lot${summary.watchlistCount === 1 ? '' : 's'} watched`
              : "You haven't added any lots to your watchlist yet."
        }
        chevron
        onPress={() => router.push('/(tabs)/watchlist' as never)}
      />

      {/* My bids (last 30 days) */}
      <NavCard
        title="My bids (last 30 days)"
        body={
          summary.loading
            ? 'Loading…'
            : summary.recentBidsCount > 0
              ? `${summary.recentBidsCount} bid${summary.recentBidsCount === 1 ? '' : 's'} placed`
              : "You haven't placed any bids yet."
        }
        chevron
        onPress={() => router.push('/(tabs)/my-bids' as never)}
      />

      {/* Past wins — S6b. Shows every lot the bidder has won across
          closed auctions with paid/unpaid/refunded/forfeited status.
          Complements the Receipts list (invoices) by surfacing the
          lot-level view rather than the invoice-level view. */}
      <NavCard
        title="Past wins"
        body="View all your auction wins and payment status"
        chevron
        onPress={() => router.push('/profile/past-wins' as never)}
      />

      {/* My Stats — Sprint 1 NEW. Pure read-only dashboard of bidder
          activity (total won, savings, top categories, win rate, etc).
          Read directly from Supabase via RLS — no new endpoint. */}
      <NavCard
        title="My Stats"
        body="View your bidding stats"
        chevron
        onPress={() => router.push('/profile/stats' as never)}
      />

      {/* Feedback (2026-08-13) — the only in-app route for "the app is
          broken" / "you should build X". Everything else on this screen is
          money or inventory; without this card those reports arrive as text
          messages and get lost. Distinct from the per-invoice "Report a
          problem" dispute flow, which is money-bearing. */}
      <NavCard
        title="Report a bug or suggest an idea"
        body="Tell us what's broken or what would make BinGo better"
        chevron
        onPress={() => router.push('/profile/feedback' as never)}
      />

      {/* Saved searches — kept as a low-prominence link for parity with
          the prior screen. Surfaces as a small text link rather than a
          full card to keep the visual hierarchy on the 5 primary cards
          above. */}
      <Link href="/profile/saved-searches" asChild>
        <Pressable
          style={{
            paddingVertical: 12,
            paddingHorizontal: 4,
            marginTop: 8,
          }}
        >
          <Text
            style={{
              color: TEXT_MUTED,
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            Saved searches
          </Text>
        </Pressable>
      </Link>

      {/* Edit profile — same low-prominence treatment. */}
      <Link href="/profile/edit" asChild>
        <Pressable
          style={{
            paddingVertical: 12,
            paddingHorizontal: 4,
          }}
        >
          <Text
            style={{
              color: TEXT_MUTED,
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            Edit profile
          </Text>
        </Pressable>
      </Link>

      {/* Subscription — HIDDEN in v1 (2026-06-03, red-team MON-2/3): the
          priced "Subscribe" screen advertised digital perks and steered to
          web (Apple 3.1.1/3.1.3(a) + Play digital-goods risk). The Profile
          link is removed and the route is gated off in app/_layout.tsx so
          the screen is unreachable in the binary. Memberships are web-only
          for v1; the member-facing rewrite to the 3 real-world perks is a
          later phase. */}

      {/* Sign out — ghost variant of BrandedButton so it reads as
          actionable but doesn't compete with the primary CTAs above. */}
      <View style={{ marginTop: 24 }}>
        <BrandedButton variant="ghost" size="md" onPress={handleSignOut}>
          Sign out
        </BrandedButton>
      </View>

      {/* Apple App Store Guideline 5.1.1(v): in-app account deletion.
         Lives at the bottom of the profile screen as a low-prominence
         destructive action — visible enough to satisfy review, but not
         something a bidder tapping around would hit accidentally.
         Uses router.push() rather than <Link> to avoid the typed-routes
         cache being stale on this freshly-added route. */}
      <Pressable
        onPress={() => router.push('/profile/delete-account' as never)}
        style={{
          padding: 12,
          marginTop: 8,
          borderWidth: 0,
          borderRadius: 6,
        }}
      >
        <Text
          style={{
            color: TEXT_MUTED,
            textAlign: 'center',
            fontSize: 13,
            textDecorationLine: 'underline',
          }}
        >
          Delete account
        </Text>
      </Pressable>

      {/* Build + OTA identity, tappable to force an update check. Exists
          because a full tester week was lost to "is this device on the new
          bundle?" guesswork (rounds 3-6) — now the answer is on screen and
          the fix is one tap instead of superstitious cold-launch rituals. */}
      <UpdateStatusRow />
    </ScrollView>
  );
}

function UpdateStatusRow() {
  const [checking, setChecking] = useState(false);
  const version = Constants.expoConfig?.version ?? '?';
  // Embedded builds report null updateId — label it so "embedded" reads as
  // "never applied an OTA" during support conversations.
  const updateShort = Updates.updateId ? Updates.updateId.slice(0, 8) : 'embedded';

  async function checkNow() {
    if (checking) return;
    setChecking(true);
    try {
      const res = await Updates.checkForUpdateAsync();
      if (!res.isAvailable) {
        Alert.alert('Up to date', `You're on the latest version (v${version} · ${updateShort}).`);
        return;
      }
      await Updates.fetchUpdateAsync();
      Alert.alert('Update ready', 'Restarting with the latest version…', [
        { text: 'OK', onPress: () => void Updates.reloadAsync() },
      ]);
    } catch (err) {
      Alert.alert('Update check failed', (err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <Pressable onPress={() => void checkNow()} style={{ padding: 12, marginTop: 4 }}>
      <Text style={{ color: TEXT_MUTED, textAlign: 'center', fontSize: 12 }}>
        {checking
          ? 'Checking for updates…'
          : `v${version} · ${updateShort} — tap to check for updates`}
      </Text>
    </Pressable>
  );
}

// Payment-method card. When there's no card on file we surface the
// primary CTA from BrandedButton (this is the only screen where the
// missing-card state actively blocks a workflow). When there IS a card,
// we shrink the card to a summary row + small "Update card" button —
// signaling the bidder is set up.
function PaymentMethodCard({ hasCard, loading }: { hasCard: boolean; loading: boolean }) {
  return (
    <View
      style={{
        backgroundColor: CARD_BG,
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: CARD_BORDER,
        minHeight: 44, // a11y tap-target floor even on the loading skeleton
      }}
    >
      <Text
        style={{
          color: TEXT_PRIMARY,
          fontSize: 16,
          fontWeight: '700',
          marginBottom: 6,
        }}
      >
        Payment method
      </Text>
      {loading ? (
        <View
          style={{
            height: 18,
            backgroundColor: CARD_BORDER,
            borderRadius: 4,
            width: '70%',
          }}
        />
      ) : hasCard ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <Text style={{ color: TEXT_MUTED, fontSize: 14, flex: 1 }}>
            We&apos;ll auto-charge your saved card when you win.
          </Text>
          <Pressable
            onPress={() => router.push('/profile/payment-method' as never)}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: BRAND_GREEN,
            }}
          >
            <Text
              style={{
                color: BRAND_GREEN,
                fontSize: 12,
                fontWeight: '700',
              }}
            >
              Update card
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          <Text style={{ color: TEXT_MUTED, fontSize: 14 }}>
            No card on file. You&apos;ll need one to bid.
          </Text>
          <BrandedButton
            variant="primary"
            size="md"
            onPress={() => router.push('/profile/payment-method' as never)}
          >
            Add a card
          </BrandedButton>
        </View>
      )}
    </View>
  );
}

// Generic 2-line nav card with chevron — Receipts / Watchlist / My bids
// / My Stats all use this. Single-purpose component so empty / non-empty
// state is just a body-text swap at the call-site.
function NavCard({
  title,
  body,
  chevron,
  onPress,
}: {
  title: string;
  body: string;
  chevron?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: CARD_BG,
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: CARD_BORDER,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? 0.85 : 1,
        minHeight: 60, // ensures 44pt tap target with internal padding
      })}
    >
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: TEXT_PRIMARY,
            fontSize: 16,
            fontWeight: '700',
            marginBottom: 4,
          }}
        >
          {title}
        </Text>
        <Text style={{ color: TEXT_MUTED, fontSize: 14 }} numberOfLines={2}>
          {body}
        </Text>
      </View>
      {chevron && (
        <Text
          style={{
            color: TEXT_MUTED,
            fontSize: 22,
            fontWeight: '300',
            marginRight: 4,
          }}
        >
          ›
        </Text>
      )}
    </Pressable>
  );
}

// Loading skeleton kept inline above (PaymentMethodCard handles its own
// loading state). We avoid a top-level ActivityIndicator so the cards
// render their structure immediately and only the data populates async.
