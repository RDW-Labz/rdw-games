// Lot photo carousel — horizontal scroll, snap-to-page, page indicator.
// Loads each stored photo directly. It used to request a Supabase Storage
// transform (?width=screen*2) per photo; Supabase bills transformations per
// distinct origin image, so every photo of every lot a bidder opened counted
// against the 100-image quota, while stored photos are already small (see
// PhotoWithFallback). A photo that fails shows a placeholder, never a black
// box (staff report 2026-07-22).

import { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Dimensions,
  Pressable,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { colors } from '@auction-platform/design-system';
import { PhotoLightbox } from './PhotoLightbox';
import { PhotoWithFallback } from './PhotoWithFallback';

export function PhotoCarousel({ photos }: { photos: string[] }) {
  const [page, setPage] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const screen = Dimensions.get('window');
  const width = screen.width;
  const height = Math.round((width * 3) / 4); // 4:3

  if (photos.length === 0) {
    return (
      <View
        style={{
          width,
          height,
          backgroundColor: colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>No photos</Text>
      </View>
    );
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    if (next !== page) setPage(next);
  }

  return (
    <View style={{ position: 'relative' }}>
      <ScrollView
        horizontal
        pagingEnabled
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsHorizontalScrollIndicator={false}
      >
        {photos.map((url, i) => (
          <Pressable key={url} onPress={() => setLightboxOpen(true)}>
            <PhotoWithFallback
              url={url}
              width={width}
              height={height}
              transition={i === page ? 0 : 200}
              tone="light"
              style={{ backgroundColor: colors.surface }}
            />
          </Pressable>
        ))}
      </ScrollView>
      <PhotoLightbox
        visible={lightboxOpen}
        photos={photos}
        initialIndex={page}
        onClose={() => setLightboxOpen(false)}
      />
      {photos.length > 1 && (
        <View
          style={{
            position: 'absolute',
            bottom: 12,
            left: 0,
            right: 0,
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          {photos.map((_, i) => (
            <View
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i === page ? '#fff' : 'rgba(255, 255, 255, 0.4)',
              }}
            />
          ))}
        </View>
      )}
      {photos.length > 1 && (
        <View
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 10,
            backgroundColor: 'rgba(0, 0, 0, 0.55)',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 11 }}>
            {page + 1} / {photos.length}
          </Text>
        </View>
      )}
    </View>
  );
}
