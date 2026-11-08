// Identity verification entry point. Triggered when a bidder tries to bid
// above the unverified threshold. Opens the verification partner's hosted flow
// in expo-web-browser; on return we re-poll bidders.identity_verified_at
// (the webhook is authoritative).

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, Alert } from 'react-native';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

export default function VerifyIdentityScreen() {
  const [verifiedAt, setVerifiedAt] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    const { data } = await supabase
      .from('bidders')
      .select('identity_verified_at')
      .eq('id', u.user.id)
      .single();
    setVerifiedAt((data?.identity_verified_at as string | null) ?? null);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function start() {
    setBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(`${API_BASE}/api/identity/verify`, {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `Server returned ${res.status}`);
      }
      const body = (await res.json()) as { url?: string };
      if (!body.url) throw new Error('No URL returned');
      await WebBrowser.openBrowserAsync(body.url);
      await refresh();
    } catch (err) {
      Alert.alert('Couldn\'t start verification', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (verifiedAt === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#8a93a6" />
      </View>
    );
  }

  if (verifiedAt) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: 'center' }}>
        <Text style={{ color: '#34d39a', fontSize: 24, fontWeight: '700' }}>Verified</Text>
        <Text style={{ color: '#8a93a6', marginTop: 8 }}>
          You completed identity verification on{' '}
          {new Date(verifiedAt).toLocaleDateString()}.
        </Text>
        <Pressable
          onPress={() => router.back()}
          style={{ marginTop: 24, padding: 14, backgroundColor: '#4f8cff', borderRadius: 6 }}
        >
          <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '600' }}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, padding: 24 }}>
      <Text style={{ color: '#e8eaf0', fontSize: 22, fontWeight: '700' }}>Verify your identity</Text>
      <Text style={{ color: '#8a93a6', marginTop: 8, lineHeight: 20 }}>
        We verify high-value bidders with a quick ID check — a photo of a government
        ID and a selfie. Our verification partner handles it; we never see your ID.
      </Text>
      <Pressable
        onPress={start}
        disabled={busy}
        style={{
          marginTop: 24,
          padding: 16,
          backgroundColor: '#4f8cff',
          borderRadius: 8,
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700', fontSize: 16 }}>
            Start verification
          </Text>
        )}
      </Pressable>
    </View>
  );
}
