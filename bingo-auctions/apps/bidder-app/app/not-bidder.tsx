// Wrong-app fallback for the bidder app. Reached when a signed-in
// user has an `operator_users` row (= warehouse staff) instead of a
// `bidders` row. Mirrors field-mobile's /not-staff screen.
//
// Why: a staff member who installs the bidder app would otherwise
// land in (tabs)/index.tsx with empty lists everywhere (RLS hides
// every row), creating a "broken app" impression. This screen
// surfaces a clear "wrong app" message and a sign-out path.

import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';

export default function NotBidderScreen() {
  const router = useRouter();

  async function signOut() {
    // scope:'local' — this device only (see 2026-07-10 shared-login incident).
    await supabase.auth.signOut({ scope: 'local' });
    router.replace('/login');
  }

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        padding: 24,
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: '#4f8cff',
          fontSize: 11,
          fontWeight: '800',
          letterSpacing: 1.4,
          textTransform: 'uppercase',
          marginBottom: 12,
        }}
      >
        BinGo Auctions
      </Text>
      <Text
        style={{
          color: '#e8eaf0',
          fontSize: 28,
          fontWeight: '900',
          letterSpacing: -0.6,
          marginBottom: 12,
        }}
      >
        Wrong app for this account
      </Text>
      <Text style={{ color: '#9ca3af', fontSize: 14, lineHeight: 22 }}>
        This account is registered as warehouse staff. The bidder app is
        for buyers. To run intake or build auctions, install the BinGo Staff
        app. To bid on auctions, sign out and create a separate
        bidder account.
      </Text>
      <Pressable
        onPress={signOut}
        style={{
          marginTop: 24,
          padding: 16,
          borderColor: '#232839',
          borderWidth: 1,
          borderRadius: 10,
        }}
      >
        <Text
          style={{
            color: '#e8eaf0',
            textAlign: 'center',
            fontSize: 14,
            fontWeight: '800',
            letterSpacing: 1.2,
            textTransform: 'uppercase',
          }}
        >
          Sign out
        </Text>
      </Pressable>
    </View>
  );
}
