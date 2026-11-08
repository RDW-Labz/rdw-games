// Saved searches — bidder's list, with delete and notify-toggle.
//
// Tapping a row opens the browse tab pre-filtered by the saved
// criteria. Toggle the bell icon to mute/unmute push.

import { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { colors, type } from '@auction-platform/design-system';
import {
  listSavedSearches,
  deleteSavedSearch,
  updateSavedSearchNotify,
  summarizeCriteria,
  type SavedSearch,
} from '@auction-platform/domain-bidding';
import { useCategories } from '@auction-platform/domain-bidding';

export default function SavedSearchesScreen() {
  const router = useRouter();
  const categories = useCategories();
  const [items, setItems] = useState<SavedSearch[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const rows = await listSavedSearches();
    setItems(rows);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load]),
  );

  async function onDelete(id: string, name: string) {
    Alert.alert('Delete saved search?', `"${name}" will stop sending push alerts.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const ok = await deleteSavedSearch(id);
          if (ok) setItems((prev) => prev.filter((s) => s.id !== id));
        },
      },
    ]);
  }

  async function onToggleNotify(id: string, next: boolean) {
    setItems((prev) => prev.map((s) => (s.id === id ? { ...s, notify: next } : s)));
    const ok = await updateSavedSearchNotify(id, next);
    if (!ok) {
      // Revert if the server rejected — keeps UI honest.
      setItems((prev) => prev.map((s) => (s.id === id ? { ...s, notify: !next } : s)));
    }
  }

  function onApply(s: SavedSearch) {
    // Push to the browse tab with criteria as URL params. Browse reads
    // them on mount and pre-fills its filter state.
    const c = s.criteria;
    const params: Record<string, string> = {};
    if (c.q) params.q = c.q;
    if (c.category_id) params.category_id = c.category_id;
    if (c.operator_id) params.operator_id = c.operator_id;
    if (c.min_discount_pct) params.min_discount_pct = String(c.min_discount_pct);
    router.push({ pathname: '/(tabs)', params });
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
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 24 }}>
        <Text style={{ color: colors.text, fontSize: 18, ...type.display, marginBottom: 8 }}>
          No saved searches yet
        </Text>
        <Text style={{ color: colors.textMuted, lineHeight: 20 }}>
          From the Browse tab, type a search or pick a category, then tap{' '}
          <Text style={{ color: colors.primary, fontWeight: '700' }}>💾 Save this search</Text>.
          You&apos;ll get a push when new lots match.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 12, gap: 8 }}
      data={items}
      keyExtractor={(s) => s.id}
      // Perf: rows are variable height so no getItemLayout, but clip
      // offscreen + small window keeps long lists smooth on low-end
      // Android (UX-P1-9 from 2026-05-24 audit).
      removeClippedSubviews
      windowSize={7}
      initialNumToRender={8}
      maxToRenderPerBatch={6}
      renderItem={({ item }) => (
        <View
          style={{
            padding: 14,
            backgroundColor: colors.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>
                {item.name}
              </Text>
              <Text
                style={{
                  color: colors.textMuted,
                  fontSize: 12,
                  marginTop: 4,
                  lineHeight: 18,
                }}
              >
                {summarizeCriteria(item.criteria, {
                  categoryNameById: (id) => categories?.byId[id]?.name,
                })}
              </Text>
              {item.last_matched_at && (
                <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 6 }}>
                  Last match: {new Date(item.last_matched_at).toLocaleString()}
                </Text>
              )}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 8 }}>
              <Switch
                value={item.notify}
                onValueChange={(v) => onToggleNotify(item.id, v)}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor={item.notify ? '#fff' : colors.textMuted}
                accessibilityLabel={`Push notifications for ${item.name}`}
                accessibilityHint={
                  item.notify
                    ? 'Currently on. Toggle to mute alerts for this saved search.'
                    : 'Currently muted. Toggle to receive alerts when new lots match.'
                }
              />
              <Text style={{ color: colors.textDim, fontSize: 10 }}>
                {item.notify ? 'Push on' : 'Muted'}
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Pressable
              onPress={() => onApply(item)}
              accessibilityRole="button"
              accessibilityLabel={`Apply saved search ${item.name}`}
              accessibilityHint="Opens the browse tab pre-filtered by this saved search's criteria"
              style={{
                flex: 1,
                minHeight: 44,
                paddingVertical: 10,
                backgroundColor: colors.primary,
                borderRadius: 8,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: '#000', fontSize: 13, ...type.label }}>Apply</Text>
            </Pressable>
            <Pressable
              onPress={() => onDelete(item.id, item.name)}
              accessibilityRole="button"
              accessibilityLabel={`Delete saved search ${item.name}`}
              accessibilityHint="Removes this saved search and stops push alerts"
              style={{
                minHeight: 44,
                paddingVertical: 10,
                paddingHorizontal: 16,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 8,
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '700' }}>
                Delete
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    />
  );
}
