// One lot photo with a bounded fallback: each source in photoSourceChain is
// tried once, in order, then a placeholder is shown. The attempt counter only
// moves forward (nextPhotoAttempt), so a failing photo can never loop, and
// the placeholder is a plain View, which cannot fail to load.
//
// The attempt is tied to the URL it was made for, so a different photo
// always starts a fresh chain (parents also key this by URL).
//
// No Supabase render/transform URL is requested here: Supabase bills image
// transformations per distinct origin image, and stored lot photos are
// already small (staff uploads are capped at 1200px; prod lot-photos median
// 248 KB, p90 454 KB on 2026-09-24). See packages/shared/src/photo-url.ts.

import { useState } from 'react';
import { View, Text, type ImageStyle, type StyleProp } from 'react-native';
import { Image } from 'expo-image';
import { nextPhotoAttempt, photoSourceChain } from '@auction-platform/shared';
import { colors } from '@auction-platform/design-system';

export function PhotoWithFallback({
  url,
  width,
  height,
  transition,
  tone,
  style,
}: {
  url: string;
  width: number;
  height: number;
  transition?: number;
  /** Placeholder colours: 'light' for in-page surfaces, 'dark' for the lightbox. */
  tone: 'light' | 'dark';
  style?: StyleProp<ImageStyle>;
}) {
  const chain = photoSourceChain(url);
  const [tried, setTried] = useState({ url, attempt: 0 });
  const attempt = tried.url === url ? tried.attempt : 0;
  const source = chain[attempt];

  if (!source) {
    return (
      <View
        accessibilityLabel="Photo unavailable"
        style={{
          width,
          height,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tone === 'dark' ? '#000' : colors.surface,
        }}
      >
        <Text
          style={{
            color: tone === 'dark' ? 'rgba(255,255,255,0.7)' : colors.textMuted,
            fontSize: 13,
          }}
        >
          Photo unavailable
        </Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri: source }}
      style={[{ width, height }, style]}
      contentFit="contain"
      transition={transition}
      cachePolicy="memory-disk"
      onError={() => setTried({ url, attempt: nextPhotoAttempt(attempt, chain.length) })}
    />
  );
}
