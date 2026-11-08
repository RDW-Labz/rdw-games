// /profile/payment-method — card on file, via the WEB Square form.
//
// 2026-07 rewrite — Stripe → Square web handoff. The previous version ran
// Stripe's SetupIntent + PaymentSheet natively. That's dead: prod cut over
// to Square (web Web Payments SDK), and adding a native payments SDK to
// this app is off the table — Stripe (and Sentry) both caused iOS launch
// deadlocks historically (see app/_layout.tsx). So instead of a native
// card sheet we reuse the already-working WEB Square form:
//
//   1. Read the bidder's current card (default_payment_method_id +
//      card_brand/card_last4) from supabase and show it if present.
//   2. "Add / update card" → grab the live Supabase session, build a
//      handoff URL that carries the tokens in the URL HASH (never the query
//      string, so they're not server-logged):
//        https://bingoauctions.com/auth/handoff#access_token=<t>&refresh_token=<r>&next=/bidder/onboarding/payment-method
//      Open it with WebBrowser.openBrowserAsync(url, FULL_SCREEN) — a full-screen
//      SFSafariViewController, NOT openAuthSessionAsync: the ASWebAuthenticationSession
//      sheet broke keyboard input into the Square card iframes on iOS (tester
//      2026-07-02 — fields focus but no keyboard, only the scan-card affordance),
//      and it's meant for OAuth redirects, not typing card data. Every other web
//      handoff in this app (identity, subscription, legal) already uses
//      openBrowserAsync.
//      The web page re-establishes the session (supabase.auth.setSession)
//      and drops the bidder onto the web Square card form. On save the web
//      form bounces to `next`; the bidder taps Done and the in-app browser
//      returns control here.
//   3. On return, refetch the card so the newly-saved card shows.
//
// Card requirement is enforced at bid time: place_bid returns
// 'no_payment_method' (migration 0105) and app/lot/[id].tsx routes here.
// Onboarding mode (?onboarding=1) shows the welcome banner and a
// non-blocking "Maybe later" escape (Apple Guideline 2.1, 2026-06-02).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Device from 'expo-device';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import { requireZip } from '@/lib/zip-gate';

// Operator-web origin that hosts the Square form + the /auth/handoff page.
// Falls back to prod when the env var is absent (matches signup.tsx).
const OPERATOR_WEB_URL =
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_OPERATOR_WEB_URL) ||
  'https://bingoauctions.com';

// Where the web form lands after a save. The handoff page defaults to this
// too; we pass it explicitly so the contract is visible at the call site.
const CARD_FORM_PATH = '/bidder/onboarding/payment-method';


// iPad hardware detection. Platform.isPad is USELESS here: app.config.ts sets
// ios.supportsTablet=false, so iPads run the iPhone binary in compatibility
// mode and UIDevice reports the *phone* idiom — Platform.isPad is false on
// every iPad (which is why the 2026-07-02 "iPads go straight to Safari" fix
// never fired on the tester's device). expo-device's modelId/modelName come
// from utsname.machine — hardware truth ("iPad13,4") regardless of idiom.
function isIpadHardware(): boolean {
  if (Platform.OS !== 'ios') return false;
  if (Platform.isPad) return true;
  return `${Device.modelId ?? ''} ${Device.modelName ?? ''}`
    .toLowerCase()
    .includes('ipad');
}

type BidderCard = {
  default_payment_method_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
};

/** Pretty brand label. Square stores brands upper-snake (VISA,
 *  AMERICAN_EXPRESS); Stripe legacy rows may be lower (visa). Handle both. */
function formatBrand(brand: string | null): string {
  if (!brand) return 'Card';
  const map: Record<string, string> = {
    VISA: 'Visa',
    MASTERCARD: 'Mastercard',
    AMERICAN_EXPRESS: 'American Express',
    AMEX: 'American Express',
    DISCOVER: 'Discover',
    JCB: 'JCB',
    DISCOVER_DINERS: 'Diners',
    CHINA_UNIONPAY: 'UnionPay',
  };
  return map[brand.toUpperCase()] ?? brand;
}

export default function PaymentMethodScreen() {
  const router = useRouter();
  // ?onboarding=1 → welcome banner + route back to /(tabs) after a save,
  // plus the non-blocking "Maybe later" escape.
  const { onboarding } = useLocalSearchParams<{ onboarding?: string }>();
  const isOnboarding = onboarding === '1';

  const [card, setCard] = useState<BidderCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  /** Read the bidder's current card crumbs. RLS scopes the row to the
   *  calling bidder via the Supabase session. */
  const loadCard = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        setCard(null);
        setLoadError('Your session expired. Please sign in again.');
        return;
      }
      const { data, error } = await supabase
        .from('bidders')
        .select('default_payment_method_id, card_brand, card_last4')
        .eq('id', u.user.id)
        .maybeSingle();
      if (error) {
        setCard(null);
        setLoadError("Couldn't load your card. Pull to retry.");
        return;
      }
      setCard((data as BidderCard | null) ?? null);
    } catch {
      setCard(null);
      setLoadError("Couldn't load your card. Check your connection.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCard();
  }, [loadCard]);

  // Build the session-handoff URL for the web Square form. Tokens ride in
  // the HASH fragment so they are never sent to the server / access logs.
  async function buildHandoffUrl(): Promise<string | null> {
    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData.session;
    if (!session?.access_token || !session.refresh_token) {
      Alert.alert('Sign-in expired', 'Please sign in again.');
      router.replace('/login');
      return null;
    }
    const hash = new URLSearchParams({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      next: CARD_FORM_PATH,
    }).toString();
    return `${OPERATOR_WEB_URL}/auth/handoff#${hash}`;
  }

  // ── Add / update card — open the WEB Square form via session handoff ──
  async function addCard() {
    if (working) return;

    // Mandatory ZIP block, one-time (ZIP-required-before-bid/checkout plan):
    // adding a card is a checkout path. The web Square form checks this too
    // (apps/operator-web SquareCardForm), so this is belt-and-suspenders —
    // it just saves a trip to the in-app browser when the ZIP is missing.
    setWorking(true);
    const hasZip = await requireZip();
    setWorking(false);
    if (!hasZip) return;

    // iPad: even the FULL_SCREEN SFSafariViewController won't raise the
    // keyboard on the Square card iframes (tester, iPadOS 26.5, 2026-07-02
    // — reproduced across two builds). Real Safari always works, so iPads
    // skip the in-app browser entirely. Detection must be hardware-based
    // (see isIpadHardware) — Platform.isPad is false in this iPhone-only app.
    if (isIpadHardware()) {
      await addCardInSafari();
      return;
    }

    setWorking(true);
    try {
      const url = await buildHandoffUrl();
      if (!url) return;

      // Full-screen SFSafariViewController (see file-top note: the auth-session
      // sheet killed keyboard input into the Square card iframes on iOS).
      // Resolves when the user taps Done; we then refetch the saved card.
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
      });

      // Refetch regardless of the result type — the user may have saved a
      // card and then hit Done (a 'dismiss'), in which case there's no
      // redirect to distinguish success. The bidders row is the source of
      // truth for what actually saved.
      await loadCard();

      // If we're gating onboarding and a card is now on file, clear the
      // gate and head back to the tabs. If they backed out without saving,
      // stay put so they can try again or use the escape hatch.
      if (isOnboarding) {
        const { data: u } = await supabase.auth.getUser();
        if (u.user) {
          const { data } = await supabase
            .from('bidders')
            .select('default_payment_method_id')
            .eq('id', u.user.id)
            .maybeSingle();
          if ((data as BidderCard | null)?.default_payment_method_id) {
            router.replace('/(tabs)' as never);
          }
        }
      }
    } catch (err) {
      Alert.alert("Couldn't open the card form", (err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  // ── Fallback: open the same form in the REAL Safari app ──
  // Escape hatch for devices where even the full-screen in-app browser won't
  // raise the keyboard on the Square card iframes (tester's iPad, 2026-07-02).
  // Linking.openURL leaves the app entirely; the AppState listener below
  // refetches the saved card when the user switches back.
  const safariHandoff = useRef(false);
  async function addCardInSafari() {
    if (working) return;
    // Mandatory ZIP block (see addCard() above) — this is also reachable
    // directly from the "open in Safari" escape-hatch button below.
    setWorking(true);
    const hasZip = await requireZip();
    setWorking(false);
    if (!hasZip) return;
    setWorking(true);
    try {
      const url = await buildHandoffUrl();
      if (!url) return;
      safariHandoff.current = true;
      await Linking.openURL(url);
    } catch (err) {
      Alert.alert("Couldn't open Safari", (err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && safariHandoff.current) {
        safariHandoff.current = false;
        loadCard();
      }
    });
    return () => sub.remove();
  }, [loadCard]);

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const hasCard = Boolean(card?.default_payment_method_id);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 24, paddingBottom: 64 }}
    >
      {isOnboarding && (
        <View
          style={{
            padding: 14,
            backgroundColor: colors.primaryDim,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.primary,
            marginBottom: 18,
          }}
        >
          <Text
            style={{
              color: colors.primary,
              fontSize: 11,
              ...type.label,
              marginBottom: 4,
            }}
          >
            One last thing
          </Text>
          <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>
            Add a card to start bidding. We&apos;ll charge it automatically
            when you win a lot — no manual checkout.
          </Text>
        </View>
      )}

      <Text
        style={{
          color: colors.textMuted,
          fontSize: 11,
          ...type.label,
          marginBottom: 6,
        }}
      >
        Payment method
      </Text>
      <Text
        style={{
          color: colors.text,
          fontSize: 24,
          ...type.display,
          marginBottom: 14,
        }}
      >
        {hasCard ? 'Your card' : 'Add a card'}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20, marginBottom: 24 }}>
        Your card is saved securely with Square. When you win a lot, it&apos;s
        charged automatically. If a charge fails, we&apos;ll notify you and
        give you time to update before the lot is relisted. You add or update
        your card on our secure web page — it opens in a browser and returns
        you here when you&apos;re done.
      </Text>

      {loadError && (
        <View
          style={{
            padding: 14,
            backgroundColor: colors.dangerDim,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.danger,
            marginBottom: 18,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '700' }}>
            {loadError}
          </Text>
        </View>
      )}

      {hasCard ? (
        <View
          style={{
            padding: 16,
            backgroundColor: colors.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.primary,
            marginBottom: 24,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 17, ...type.display }}>
                {formatBrand(card?.card_brand ?? null)} •••• {card?.card_last4 ?? '????'}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }}>
                Card on file
              </Text>
            </View>
            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                backgroundColor: colors.primaryDim,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: colors.primary,
              }}
            >
              <Text style={{ color: colors.primary, fontSize: 11, ...type.label }}>
                Primary
              </Text>
            </View>
          </View>
        </View>
      ) : (
        !loadError && (
          <View
            style={{
              padding: 16,
              backgroundColor: colors.surface,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: colors.border,
              marginBottom: 24,
            }}
          >
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>
              No card on file yet. Add one below to start bidding.
            </Text>
          </View>
        )
      )}

      <Pressable
        onPress={addCard}
        disabled={working}
        style={{
          marginTop: 12,
          padding: 18,
          backgroundColor: colors.primary,
          borderRadius: 12,
          opacity: working ? 0.6 : 1,
        }}
      >
        {working ? (
          <ActivityIndicator color="#000" />
        ) : (
          <Text
            style={{
              color: '#000',
              textAlign: 'center',
              fontSize: 15,
              ...type.label,
            }}
          >
            {hasCard ? 'Add / update card' : 'Add card'}
          </Text>
        )}
      </Pressable>

      <Pressable onPress={addCardInSafari} disabled={working} style={{ marginTop: 14, padding: 8 }}>
        <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 13 }}>
          Keyboard not working? <Text style={{ color: colors.primary }}>Open in Safari instead</Text>
        </Text>
      </Pressable>

      {!isOnboarding && (
        <Pressable
          onPress={() => router.back()}
          disabled={working}
          style={{ marginTop: 16, padding: 12 }}
        >
          <Text
            style={{ color: colors.textMuted, textAlign: 'center', fontSize: 13 }}
          >
            Back
          </Text>
        </Pressable>
      )}

      {/* Non-blocking onboarding escape (Apple Guideline 2.1, 2026-06-02):
          adding a card must never block browsing — it's only required at
          bid time (place_bid → 'no_payment_method' → app/lot/[id].tsx). */}
      {isOnboarding && (
        <Pressable
          onPress={() => router.replace('/(tabs)' as never)}
          disabled={working}
          style={{ marginTop: 16, padding: 12 }}
        >
          <Text
            style={{ color: colors.textMuted, textAlign: 'center', fontSize: 13 }}
          >
            Maybe later — browse auctions
          </Text>
        </Pressable>
      )}
    </ScrollView>
  );
}
