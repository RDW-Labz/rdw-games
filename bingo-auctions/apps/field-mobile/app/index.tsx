// Landing route. Once auth resolves, route into (staff) — the strict
// role gate inside (staff)/_layout.tsx then either lets the user
// through, or kicks them to /not-staff.

import { useEffect } from 'react';
import { View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '@auction-platform/design-system';

export default function LandingScreen() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/(staff)');
  }, [router]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: colors.textMuted }}>Loading…</Text>
    </View>
  );
}
