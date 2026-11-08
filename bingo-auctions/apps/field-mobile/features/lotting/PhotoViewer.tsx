// Full-screen photo viewer for LotTR thumbnail strips.
//
// Usage:
//   const viewer = usePhotoViewer();
//   <Pressable onPress={() => viewer.open(urls, idx)}>...</Pressable>
//   <PhotoViewer state={viewer.state} onClose={viewer.close} />
//
// Design choices:
//   - Modal (RN built-in) — opens above the whole app, no nav side-effects
//   - Horizontal paged ScrollView for multi-photo swipe (snap-to-page)
//   - Tap anywhere to close. Avoids needing a visible close button on top
//     of the image (keeps the image full-bleed)
//   - Background is solid black so dark-mode-aware lightbox is automatic
//   - Index dots only render when there are 2+ photos
//   - expo-image with contentFit="contain" so portrait/landscape both
//     show without crop. cachePolicy reuses the memory cache the strip
//     already filled, so no second network fetch when opening
//
// Local + remote URIs both work (Image source accepts file:// and https://).

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Modal,
  View,
  Pressable,
  ScrollView,
  Dimensions,
  StyleSheet,
  Text,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type PhotoViewerState = {
  open: boolean;
  urls: string[];
  startIndex: number;
};

const CLOSED: PhotoViewerState = { open: false, urls: [], startIndex: 0 };

export function usePhotoViewer(): {
  state: PhotoViewerState;
  open: (urls: string[], index?: number) => void;
  close: () => void;
} {
  const [state, setState] = useState<PhotoViewerState>(CLOSED);
  return {
    state,
    open: useCallback((urls: string[], index = 0) => {
      const cleaned = urls.filter((u) => typeof u === 'string' && u.trim().length > 0);
      if (cleaned.length === 0) return;
      const safeIdx = Math.max(0, Math.min(index, cleaned.length - 1));
      setState({ open: true, urls: cleaned, startIndex: safeIdx });
    }, []),
    close: useCallback(() => setState(CLOSED), []),
  };
}

export function PhotoViewer({
  state,
  onClose,
}: {
  state: PhotoViewerState;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = Dimensions.get('window');
  const scrollRef = useRef<ScrollView | null>(null);
  const [activeIdx, setActiveIdx] = useState(state.startIndex);

  // Reset scroll position when the viewer opens to a new starting index.
  // ScrollView won't auto-scroll on prop change; we have to imperative-call.
  useEffect(() => {
    if (state.open && scrollRef.current) {
      // Defer to next tick so the ScrollView has mounted with width set.
      const id = setTimeout(() => {
        scrollRef.current?.scrollTo({
          x: state.startIndex * width,
          animated: false,
        });
        setActiveIdx(state.startIndex);
      }, 0);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [state.open, state.startIndex, width]);

  if (!state.open) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <StatusBar style="light" backgroundColor="#000" />
      <Pressable style={s.backdrop} onPress={onClose}>
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={(e) => {
            const i = Math.round(e.nativeEvent.contentOffset.x / width);
            if (i !== activeIdx) setActiveIdx(i);
          }}
          scrollEventThrottle={32}
          // Stop propagation so swiping doesn't fire the backdrop close.
          // RN doesn't have stopPropagation but Pressable's onPress only
          // fires on a tap (no movement), so scrolling is already safe.
        >
          {state.urls.map((url, i) => (
            <View key={`${url}-${i}`} style={{ width, height }}>
              <Image
                source={{ uri: url }}
                style={{ flex: 1 }}
                contentFit="contain"
                cachePolicy="memory-disk"
                transition={100}
              />
            </View>
          ))}
        </ScrollView>

        {state.urls.length > 1 && (
          <View
            style={[
              s.indexBar,
              { bottom: insets.bottom + 24 },
            ]}
            pointerEvents="none"
          >
            {state.urls.map((_, i) => (
              <View
                key={i}
                style={[s.dot, i === activeIdx && s.dotActive]}
              />
            ))}
          </View>
        )}

        <View
          style={[s.counter, { top: insets.top + 12 }]}
          pointerEvents="none"
        >
          <Text style={s.counterText}>
            {activeIdx + 1} / {state.urls.length}
          </Text>
        </View>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#000',
  },
  indexBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
  dotActive: {
    backgroundColor: '#fff',
    width: 18,
  },
  counter: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  counterText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
});
