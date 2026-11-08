// Bidder memberships — one card per operator membership plan.
//
// Reads the per-plan membership model (operator_pro_plans, migration 0177):
// each active plan of an active operator is a subscribe-able offering. The old
// version read the now-defunct operators.pro_enabled / pro_monthly_cents
// columns and POSTed { operatorId } to /api/subscriptions/checkout — but that
// route requires { planId }. Both are fixed here.
//
// Active subscriptions surface their renewal date and link to the Stripe
// billing portal for cancellation.

import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Image,
  RefreshControl,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '@auction-platform/supabase-client';
import { formatCents } from '@auction-platform/shared';
import { colors } from '@auction-platform/design-system';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

// One subscribe-able membership plan, joined to its operator's branding.
type PlanOffering = {
  planId: string;
  operatorId: string;
  businessName: string;
  logoUrl: string | null;
  brandColor: string | null;
  planName: string;
  priceCents: number;
};

// Shape of the operator_pro_plans row + embedded operator we read. The bidder
// Supabase client is untyped, so we annotate the projection explicitly. The
// operators embed is a to-one relationship; PostgREST returns it as an object,
// but we defensively accept an array too.
type EmbeddedOperator = {
  business_name: string;
  logo_url: string | null;
  brand_color: string | null;
  status: string;
};
type PlanRow = {
  id: string;
  operator_id: string;
  name: string;
  price_cents: number;
  operators: EmbeddedOperator | EmbeddedOperator[] | null;
};

type Subscription = {
  operator_id: string;
  status: string;
  current_period_end: string | null;
};

export default function SubscriptionsScreen() {
  const [offerings, setOfferings] = useState<PlanOffering[]>([]);
  const [subs, setSubs] = useState<Map<string, Subscription>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    // operator_pro_plans_public_read RLS (mig 0177) already restricts this to
    // active plans of active operators, so the embed is safe to read anon.
    const [{ data: plans }, { data: u }] = await Promise.all([
      supabase
        .from('operator_pro_plans')
        .select('id, operator_id, name, price_cents, operators:operators_public(business_name, logo_url, brand_color, status)')
        .eq('active', true),
      supabase.auth.getUser(),
    ]);

    const offers: PlanOffering[] = ((plans ?? []) as unknown as PlanRow[])
      .map((p) => {
        const op = Array.isArray(p.operators) ? p.operators[0] : p.operators;
        if (!op || op.status !== 'active') return null;
        return {
          planId: p.id,
          operatorId: p.operator_id,
          businessName: op.business_name,
          logoUrl: op.logo_url,
          brandColor: op.brand_color,
          planName: p.name,
          priceCents: p.price_cents,
        } satisfies PlanOffering;
      })
      .filter((o): o is PlanOffering => o !== null);
    setOfferings(offers);

    if (u.user) {
      const { data: subRows } = await supabase
        .from('bidder_subscriptions')
        .select('operator_id, status, current_period_end')
        .eq('bidder_id', u.user.id);
      const map = new Map<string, Subscription>();
      for (const s of (subRows ?? []) as Subscription[]) map.set(s.operator_id, s);
      setSubs(map);
    }

    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function callApi(path: string, body?: Record<string, unknown>) {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Server returned ${res.status}`);
    }
    const result = (await res.json()) as { url?: string };
    if (!result.url) throw new Error('No URL returned');
    return result.url;
  }

  async function subscribe(planId: string) {
    if (Platform.OS === 'ios') {
      Alert.alert(
        'Subscribe on web',
        'Subscriptions for iOS bidders are managed at bingoauctions.com. Sign in there to subscribe.',
      );
      return;
    }
    setBusyId(planId);
    try {
      // The checkout route resolves the plan's operator + Stripe Price from
      // planId server-side (never trusted from the client).
      const url = await callApi('/api/subscriptions/checkout', { planId });
      const result = await WebBrowser.openBrowserAsync(url);
      if (result.type === 'cancel' || result.type === 'dismiss') await load();
    } catch (err) {
      Alert.alert('Couldn\'t open Checkout', (err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function manage(busyKey: string) {
    // The billing portal is per-bidder (keyed off their Stripe customer), not
    // per-operator — no body needed. busyKey only drives the spinner.
    setBusyId(busyKey);
    try {
      const url = await callApi('/api/subscriptions/portal');
      const result = await WebBrowser.openBrowserAsync(url);
      if (result.type === 'cancel' || result.type === 'dismiss') await load();
    } catch (err) {
      Alert.alert('Couldn\'t open billing', (err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

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
        <ActivityIndicator color="#8a93a6" />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 16 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor="#8a93a6"
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
        />
      }
    >
      <Text style={{ color: '#e8eaf0', fontSize: 22, fontWeight: '700' }}>Memberships</Text>
      <Text style={{ color: '#8a93a6', marginTop: 8, lineHeight: 20 }}>
        Each operator runs their own membership. Subscribe to the operators you bid with most to
        unlock the perks they offer.
      </Text>

      {offerings.length === 0 && (
        <View style={{ marginTop: 24, padding: 16, borderColor: '#232839', borderWidth: 1, borderRadius: 8 }}>
          <Text style={{ color: '#8a93a6' }}>
            No operators are offering a membership right now. Come back later, or ask your
            favorite operator to set one up in their settings.
          </Text>
        </View>
      )}

      {offerings.map((offer) => {
        const sub = subs.get(offer.operatorId);
        const active = sub?.status === 'active' || sub?.status === 'trialing';
        const busy = busyId === offer.planId;
        return (
          <View
            key={offer.planId}
            style={{
              marginTop: 16,
              padding: 16,
              backgroundColor: '#1c2e49',
              borderRadius: 8,
              borderWidth: 1,
              borderColor: active ? '#34d39a' : '#232839',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              {offer.logoUrl ? (
                <Image
                  source={{ uri: offer.logoUrl }}
                  style={{ width: 40, height: 40, borderRadius: 6 }}
                  resizeMode="contain"
                />
              ) : (
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 6,
                    backgroundColor: offer.brandColor ?? '#232839',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                    {offer.businessName.charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#e8eaf0', fontSize: 16, fontWeight: '600' }}>
                  {offer.businessName}
                </Text>
                <Text style={{ color: '#8a93a6', fontSize: 13 }}>
                  {offer.planName} · {formatCents(offer.priceCents)}/month
                </Text>
              </View>
              {active && (
                <Text style={{ color: '#34d39a', fontSize: 12, fontWeight: '600' }}>ACTIVE</Text>
              )}
            </View>

            {/* Perk rows intentionally omitted in v1 (2026-06-03): the
                membership's real-world perks (extended pickup, extra grace,
                staging & prep) live on operator_pro_plans and surface in the
                member-facing rewrite in a later phase. This screen is
                unreachable in v1 (Profile link removed + route gated off). */}

            {sub?.current_period_end && active && (
              <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 8 }}>
                Renews {new Date(sub.current_period_end).toLocaleDateString()}
              </Text>
            )}

            <Pressable
              onPress={() => (active ? manage(offer.planId) : subscribe(offer.planId))}
              disabled={busy}
              style={{
                marginTop: 12,
                padding: 12,
                backgroundColor: active ? '#232839' : '#4f8cff',
                borderRadius: 6,
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '600' }}>
                  {active ? 'Manage' : `Subscribe — ${formatCents(offer.priceCents)}/mo`}
                </Text>
              )}
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}
