// Full-screen photo viewer with pinch-to-zoom + swipe-between-photos.
//
// Why hand-rolled instead of react-native-image-viewing:
//   - Behavior is straightforward enough — nested ScrollView for pinch,
//     horizontal pager outside for swipe between images.
//
// Each photo loads the stored original (the same URL the carousel already
// cached, so opening is instant). It used to request a Supabase transform
// with no error handler, so a failed transform left a black screen. Now each
// photo tries the original once, then shows a "Photo unavailable"
// placeholder; see PhotoWithFallback.

import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  Dimensions,
  StatusBar,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useRef, useState } from 'react';
import { PhotoWithFallback } from './PhotoWithFallback';

export function PhotoLightbox({
  visible,
  photos,
  initialIndex,
  onClose,
}: {
  visible: boolean;
  photos: string[];
  initialIndex: number;
  onClose: () => void;
}) {
  const screen = Dimensions.get('window');
  const [page, setPage] = useState(initialIndex);
  const pagerRef = useRef<ScrollView | null>(null);

  function onPagerScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const next = Math.round(e.nativeEvent.contentOffset.x / screen.width);
    if (next !== page) setPage(next);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <StatusBar barStyle="light-content" />

        <ScrollView
          ref={pagerRef}
          horizontal
          pagingEnabled
          onScroll={onPagerScroll}
          scrollEventThrottle={16}
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: initialIndex * screen.width, y: 0 }}
        >
          {photos.map((url, i) => (
            // Inner ScrollView gives iOS pinch-to-zoom for free via
            // maximumZoomScale. Android falls back to swipe-only — fine for
            // an MVP. Wrap-and-go.
            <ScrollView
              key={url}
              style={{ width: screen.width, height: screen.height }}
              contentContainerStyle={{
                width: screen.width,
                height: screen.height,
                alignItems: 'center',
                justifyContent: 'center',
              }}
              maximumZoomScale={4}
              minimumZoomScale={1}
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              centerContent
            >
              <PhotoWithFallback
                url={url}
                width={screen.width}
                height={screen.height}
                transition={i === page ? 0 : 200}
                tone="dark"
              />
            </ScrollView>
          ))}
        </ScrollView>

        {/* Top bar */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            padding: 16,
            paddingTop: 56,
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 14 }}>
            {page + 1} / {photos.length}
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              backgroundColor: 'rgba(255,255,255,0.15)',
              borderRadius: 6,
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
