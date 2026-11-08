// Wrong-app fallback. Reached when a signed-in user has no
// operator_users row — they're a regular bidder who shouldn't be in
// the field app. We don't sign them out automatically (their session
// is still valid for the bidder app); just route them away.

import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';

export default function NotStaffScreen() {
  const router = useRouter();

  async function signOut() {
    // scope:'local' — sign out THIS device only. The default (global)
    // revokes every device's refresh token on the account; with staff
    // sharing one login that killed the other iPads' sessions ~1hr later
    // mid-shift ("not_authenticated" on manual checkout/refund, 2026-07-10).
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
          color: colors.primary,
          fontSize: 11,
          ...type.label,
          marginBottom: 12,
        }}
      >
        BinGo Staff
      </Text>
      <Text
        style={{
          color: colors.text,
          fontSize: 28,
          ...type.displayHero,
          marginBottom: 12,
        }}
      >
        You&apos;re not staff yet
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 14, lineHeight: 22 }}>
        This app is for warehouse staff and operators. If you&apos;re looking
        to bid on auctions, install the consumer app instead. If your
        operator hasn&apos;t added you to staff yet, ask them to invite you
        from the operator console.
      </Text>
      <Pressable
        onPress={signOut}
        style={{
          marginTop: 24,
          padding: 16,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 10,
        }}
      >
        <Text
          style={{
            color: colors.text,
            textAlign: 'center',
            fontSize: 14,
            ...type.label,
          }}
        >
          Sign out
        </Text>
      </Pressable>
    </View>
  );
}
