// Loyalty points card on the bidder-app Profile tab (2026-07-07).
//
// Customer report: "acquired points at the discount bins and don't see them
// on the BinGo app." The points were always there — Square Loyalty is shared
// across the register and the auctions, and the WEB profile has shown the
// balance since mig 0237 — but this native app never grew the card. This is
// the same card, native: live balance read from Square via the existing
// GET /api/bidder/loyalty endpoint (phone-keyed), tier redemption into
// BinGo credit via POST /api/bidder/loyalty/redeem, and an inline
// add-your-phone state for bidders who can't participate yet.
//
// Renders nothing while the feature is off or Square errors — the profile
// stays clean for the common case. All JS — OTA updatable.

import { useCallback, useState } from 'react';
import { View, Text, TextInput, Pressable, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { supabase } from '@auction-platform/supabase-client';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

const CARD_BG = '#1A1D24';
const CARD_BORDER = '#232839';
const TEXT_PRIMARY = '#e8eaf0';
const TEXT_MUTED = '#8a93a6';
const BRAND_GREEN = '#5FE065';
const DANGER = '#f87171';

type LoyaltyState = {
  enabled: boolean;
  reason?: string;
  balance?: number;
  terminology?: { one: string; other: string };
  tiers?: Array<{ id: string; points: number; name: string; credit_cents: number | null }>;
};

async function authedFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) return null;
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  });
}

export function LoyaltyCard() {
  const [state, setState] = useState<LoyaltyState | null>(null);
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/api/bidder/loyalty');
      if (!res) return;
      setState((await res.json()) as LoyaltyState);
    } catch {
      setState({ enabled: false, reason: 'network' });
    }
  }, []);

  // Refresh whenever the Profile tab gains focus — points earned at the
  // register between visits show up without a manual refresh.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!state) return null;
  if (!state.enabled && state.reason !== 'no_phone') return null;

  if (!state.enabled && state.reason === 'no_phone') {
    return <AddPhoneForLoyalty onSaved={() => void load()} />;
  }

  const pts = state.terminology ?? { one: 'Point', other: 'Points' };
  const balance = state.balance ?? 0;
  const tiers = (state.tiers ?? []).filter((t) => t.credit_cents && t.credit_cents > 0);

  const redeem = (tierId: string, creditCents: number, points: number) => {
    Alert.alert(
      'Redeem points?',
      `Redeem ${points} ${pts.other.toLowerCase()} for $${(creditCents / 100).toFixed(2)} auction credit? Points are spent immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Redeem',
          onPress: () => {
            void (async () => {
              setBusyTier(tierId);
              setMessage(null);
              try {
                const res = await authedFetch('/api/bidder/loyalty/redeem', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ tier_id: tierId, redemption_id: Crypto.randomUUID() }),
                });
                const j = (await res?.json()) as
                  | { ok: boolean; error?: string; credit_cents?: number }
                  | undefined;
                if (!j?.ok) {
                  setMessage({ ok: false, text: j?.error ?? 'Redemption failed.' });
                } else {
                  setMessage({
                    ok: true,
                    text: `$${((j.credit_cents ?? creditCents) / 100).toFixed(2)} credit added — it applies to your next invoice automatically.`,
                  });
                  await load();
                }
              } catch {
                setMessage({ ok: false, text: 'Network error — your points are safe, try again.' });
              } finally {
                setBusyTier(null);
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <View style={cardStyle}>
      <Text style={cardTitleStyle}>Loyalty points</Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: BRAND_GREEN, fontSize: 26, fontWeight: '900' }}>{balance}</Text>
        <Text style={{ color: TEXT_MUTED, fontSize: 13, flexShrink: 1 }}>
          {balance === 1 ? pts.one : pts.other} — earned at BinGo auctions and our stores, spendable
          at both.
        </Text>
      </View>
      {tiers.length > 0 && (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {tiers.map((t) => {
            const affordable = balance >= t.points;
            return (
              <Pressable
                key={t.id}
                disabled={busyTier !== null || !affordable}
                onPress={() => redeem(t.id, t.credit_cents!, t.points)}
                style={{
                  paddingVertical: 9,
                  paddingHorizontal: 14,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: affordable ? BRAND_GREEN : CARD_BORDER,
                  opacity: affordable ? 1 : 0.5,
                }}
              >
                {busyTier === t.id ? (
                  <ActivityIndicator color={BRAND_GREEN} size="small" />
                ) : (
                  <Text style={{ color: affordable ? BRAND_GREEN : TEXT_MUTED, fontSize: 13, fontWeight: '700' }}>
                    {t.points} {pts.other.toLowerCase()} → ${(t.credit_cents! / 100).toFixed(2)} credit
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
      {message && (
        <Text style={{ marginTop: 10, fontSize: 13, color: message.ok ? BRAND_GREEN : DANGER }}>
          {message.text}
        </Text>
      )}
    </View>
  );
}

// Loyalty is ON but this bidder has no phone — accounts are phone-keyed
// (the same number identifies them at the store register), so offer the
// one-field fix inline instead of hiding the feature.
function AddPhoneForLoyalty({ onSaved }: { onSaved: () => void }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch('/api/bidder/phone', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const j = (await res?.json()) as { ok: boolean; error?: string } | undefined;
      if (!j?.ok) setError(j?.error ?? 'Save failed.');
      else onSaved();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={cardStyle}>
      <Text style={cardTitleStyle}>Loyalty points</Text>
      <Text style={{ color: TEXT_MUTED, fontSize: 13, lineHeight: 19, marginBottom: 10 }}>
        Auction wins earn the same loyalty points as our stores — add your phone number to start
        collecting. Use the SAME number you give at the register so your points combine.
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          placeholder="(555) 555-5555"
          placeholderTextColor={TEXT_MUTED}
          keyboardType="phone-pad"
          maxLength={20}
          editable={!busy}
          style={{
            flex: 1,
            paddingHorizontal: 12,
            paddingVertical: 10,
            backgroundColor: '#12141a',
            borderColor: CARD_BORDER,
            borderWidth: 1,
            borderRadius: 8,
            color: TEXT_PRIMARY,
            fontSize: 14,
          }}
        />
        <Pressable
          onPress={save}
          disabled={busy || !phone.trim()}
          style={{
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: 8,
            backgroundColor: BRAND_GREEN,
            opacity: busy || !phone.trim() ? 0.5 : 1,
          }}
        >
          {busy ? (
            <ActivityIndicator color="#000" size="small" />
          ) : (
            <Text style={{ color: '#000', fontSize: 13, fontWeight: '800' }}>Start earning</Text>
          )}
        </Pressable>
      </View>
      {error && <Text style={{ marginTop: 8, fontSize: 13, color: DANGER }}>{error}</Text>}
    </View>
  );
}

const cardStyle = {
  backgroundColor: CARD_BG,
  borderColor: CARD_BORDER,
  borderWidth: 1,
  borderRadius: 12,
  padding: 16,
  marginBottom: 12,
} as const;

const cardTitleStyle = {
  color: TEXT_MUTED,
  fontSize: 11,
  fontWeight: '800',
  textTransform: 'uppercase',
  letterSpacing: 1.2,
  marginBottom: 10,
} as const;
