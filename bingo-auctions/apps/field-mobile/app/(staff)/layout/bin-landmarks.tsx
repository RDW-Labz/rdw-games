// Mode 5 — bin landmark photos.
//
// Walk the warehouse, tap a bin, snap a photo of the actual shelf /
// pallet / area. Bidder pickup map renders the photo so they
// recognise the spot instead of decoding bin codes. This is probably
// the single highest-value pickup-experience win in the wedge —
// "look for THIS shelf" beats "find C-12 on a numbered map" every time.

import { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  Alert,
  RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import {
  supabase,
  useOperatorRole,
} from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import { uploadImageFromUri } from '../../../lib/upload-image';

type Bin = {
  id: string;
  code: string;
  aisle: string | null;
  landmark_photo_url: string | null;
  landmark_photo_taken_at: string | null;
};

export default function BinLandmarksScreen() {
  const role = useOperatorRole();
  const { warehouseId } = useLocalSearchParams<{ warehouseId: string }>();

  const [bins, setBins] = useState<Bin[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyBinId, setBusyBinId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!warehouseId) return;
    const { data, error } = await supabase
      .from('bins')
      .select('id, code, aisle, landmark_photo_url, landmark_photo_taken_at')
      .eq('warehouse_id', warehouseId)
      .order('aisle')
      .order('code');
    if (error) {
      Alert.alert('Load failed', error.message);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setBins((data ?? []) as Bin[]);
    setLoading(false);
    setRefreshing(false);
  }, [warehouseId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function captureFor(bin: Bin) {
    if (busyBinId || role.kind !== 'staff' || !warehouseId) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera permission needed');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;

    setBusyBinId(bin.id);
    try {
      const path = `${role.operatorId}/${warehouseId}/${bin.id}.jpg`;
      // upsert: each bin has at most one landmark photo. Re-shooting
      // overwrites the previous one at the same path.
      const upload = await uploadImageFromUri(
        'bin-landmarks',
        path,
        result.assets[0].uri,
        { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' },
      );
      if (!upload.ok) throw new Error(upload.reason);

      // Append a cache-buster so the freshly-captured photo replaces
      // any previously-cached URL on consumers (the path is the same).
      const url = `${upload.url}?t=${Date.now()}`;

      const { error: updErr } = await supabase
        .from('bins')
        .update({
          landmark_photo_url: url,
          landmark_photo_taken_at: new Date().toISOString(),
        })
        .eq('id', bin.id);
      if (updErr) throw updErr;

      setBins((prev) =>
        prev.map((b) =>
          b.id === bin.id
            ? { ...b, landmark_photo_url: url, landmark_photo_taken_at: new Date().toISOString() }
            : b,
        ),
      );
    } catch (err) {
      Alert.alert('Save failed', (err as Error).message);
    } finally {
      setBusyBinId(null);
    }
  }

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: colors.textMuted }}>Loading bins…</Text>
      </View>
    );
  }

  const landmarked = bins.filter((b) => b.landmark_photo_url).length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          padding: 16,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
          Bin landmark photos
        </Text>
        <Text
          style={{
            color: colors.text,
            fontSize: 22,
            ...type.displayHero,
            marginTop: 2,
          }}
        >
          {landmarked} / {bins.length} photographed
        </Text>
        <Text
          style={{
            color: colors.textMuted,
            fontSize: 12,
            lineHeight: 18,
            marginTop: 6,
          }}
        >
          Tap a bin, photograph the actual shelf or pallet, done. Bidders
          see the photo on their pickup map so they recognise the spot
          on arrival.
        </Text>
      </View>

      <FlatList
        data={bins}
        keyExtractor={(b) => b.id}
        contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textMuted}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        renderItem={({ item }) => (
          <BinRow
            bin={item}
            busy={busyBinId === item.id}
            onCapture={() => captureFor(item)}
          />
        )}
        ListEmptyComponent={
          <View style={{ padding: 32, alignItems: 'center' }}>
            <Text style={{ color: colors.textMuted, textAlign: 'center' }}>
              No bins in this warehouse yet. Add some in the operator console first.
            </Text>
          </View>
        }
      />
    </View>
  );
}

function BinRow({
  bin,
  busy,
  onCapture,
}: {
  bin: Bin;
  busy: boolean;
  onCapture: () => void;
}) {
  return (
    <Pressable
      onPress={onCapture}
      disabled={busy}
      style={{
        padding: 12,
        backgroundColor: colors.surface,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: bin.landmark_photo_url ? colors.success : colors.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: busy ? 0.5 : 1,
      }}
    >
      {bin.landmark_photo_url ? (
        <Image
          source={{ uri: bin.landmark_photo_url }}
          style={{
            width: 56,
            height: 56,
            borderRadius: 8,
            backgroundColor: colors.surfaceAlt,
          }}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : (
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 8,
            backgroundColor: colors.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 22 }}>📷</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: colors.primary,
            fontFamily: 'monospace',
            fontSize: 12,
            fontWeight: '900',
            letterSpacing: 0.4,
          }}
        >
          {bin.code}
        </Text>
        {bin.aisle && (
          <Text style={{ color: colors.textMuted, fontSize: 11 }}>
            Aisle {bin.aisle}
          </Text>
        )}
        <Text
          style={{
            color: bin.landmark_photo_url ? colors.success : colors.textMuted,
            fontSize: 12,
            marginTop: 2,
          }}
        >
          {busy
            ? 'Uploading…'
            : bin.landmark_photo_url
              ? 'Tap to re-shoot'
              : 'Tap to photograph'}
        </Text>
      </View>
    </Pressable>
  );
}
