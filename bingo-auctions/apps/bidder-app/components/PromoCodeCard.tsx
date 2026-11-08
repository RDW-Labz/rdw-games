// Promo-code redemption card on the bidder-app Profile tab (mig 0268).
//
// "Make the coupon redeemable in the auction app" (owner, 2026-07-15): the
// bidder types a marketing code (e.g. BINS5) and its dollar value is minted
// as BinGo credit, which the auto-charge drain applies to their next invoice
// automatically — there is no bidder checkout to apply a code at. Same shape
// as the loyalty redeem card next to it (LoyaltyCard.tsx): a single POST to
// /api/bidder/promo/redeem, success/error message inline.
//
// Always shown — any bidder may have a code — but the server enforces
// eligibility (e.g. new-bidders-only), expiry, and one-per-account, so an
// ineligible tap comes back with a clean message. All JS — OTA updatable.

import { useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { supabase } from '@auction-platform/supabase-client';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

const CARD_BG = '#1A1D24';
const CARD_BORDER = '#232839';
const TEXT_PRIMARY = '#e8eaf0';
const TEXT_MUTED = '#8a93a6';
const BRAND_GREEN = '#5FE065';
const DANGER = '#f87171';

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

export function PromoCodeCard() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const redeem = async () => {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await authedFetch('/api/bidder/promo/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
      const j = (await res?.json()) as
        | { ok: boolean; error?: string; credit_cents?: number }
        | undefined;
      if (!j?.ok) {
        setMessage({ ok: false, text: j?.error ?? 'Redemption failed.' });
      } else {
        setMessage({
          ok: true,
          text: `$${((j.credit_cents ?? 0) / 100).toFixed(2)} credit added — it comes off your next invoice automatically.`,
        });
        setCode('');
      }
    } catch {
      setMessage({ ok: false, text: 'Network error — try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={cardStyle}>
      <Text style={cardTitleStyle}>Promo code</Text>
      <Text style={{ color: TEXT_MUTED, fontSize: 13, lineHeight: 19, marginBottom: 10 }}>
        Have a code? Enter it to add credit — it applies to your next auction invoice automatically.
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TextInput
          value={code}
          onChangeText={(t) => setCode(t.toUpperCase())}
          placeholder="Enter code"
          placeholderTextColor={TEXT_MUTED}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={40}
          editable={!busy}
          onSubmitEditing={() => void redeem()}
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
            letterSpacing: 1,
          }}
        />
        <Pressable
          onPress={() => void redeem()}
          disabled={busy || !code.trim()}
          style={{
            paddingVertical: 10,
            paddingHorizontal: 16,
            borderRadius: 8,
            backgroundColor: BRAND_GREEN,
            opacity: busy || !code.trim() ? 0.5 : 1,
          }}
        >
          {busy ? (
            <ActivityIndicator color="#000" size="small" />
          ) : (
            <Text style={{ color: '#000', fontSize: 13, fontWeight: '800' }}>Apply</Text>
          )}
        </Pressable>
      </View>
      {message && (
        <Text style={{ marginTop: 10, fontSize: 13, color: message.ok ? BRAND_GREEN : DANGER }}>
          {message.text}
        </Text>
      )}
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
