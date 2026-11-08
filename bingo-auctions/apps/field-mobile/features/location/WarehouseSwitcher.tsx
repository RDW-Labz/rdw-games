// Warehouse picker sheet + header button. Mirrors WorkerSwitcher's shape so the
// two header pills read as one system.
//
// Deliberately has NO "all locations" option — see WarehouseContext. A worker is
// physically standing in one building; an ambiguous bin list is the bug this
// exists to fix.

import React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors } from '@auction-platform/design-system';
import { useWarehouse, type ActiveWarehouse } from './WarehouseContext';

export function WarehouseSwitcher() {
  const { warehouse, available, switcherOpen, closeSwitcher, select, multiLocation } =
    useWarehouse();

  // Nothing to choose between — never show the sheet to a single-location operator.
  if (!multiLocation) return null;

  const mustChoose = warehouse === null;

  return (
    <Modal
      visible={switcherOpen}
      animationType="slide"
      transparent
      // When no location is chosen yet the list is not dismissible: continuing
      // into an un-scoped bin list is exactly what we are preventing.
      onRequestClose={mustChoose ? undefined : closeSwitcher}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' }}>
        <View
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            paddingTop: 18,
            paddingBottom: 34,
            paddingHorizontal: 18,
            maxHeight: '80%',
          }}
        >
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '800' }}>
            {mustChoose ? 'Which location are you at?' : 'Switch location'}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 6, lineHeight: 19 }}>
            Bins, lots and put-away are scoped to this location. Pick the building
            you&apos;re physically standing in.
          </Text>

          <ScrollView style={{ marginTop: 16 }}>
            {available.map((w) => {
              const active = w.id === warehouse?.id;
              return (
                <Pressable
                  key={w.id}
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    select(w);
                  }}
                  style={{
                    paddingVertical: 16,
                    paddingHorizontal: 16,
                    borderRadius: 12,
                    marginBottom: 10,
                    backgroundColor: active ? colors.primaryDim : colors.surface,
                    borderWidth: 1,
                    borderColor: active ? colors.primary : colors.border,
                  }}
                >
                  <Text
                    style={{
                      color: active ? colors.primary : colors.text,
                      fontSize: 17,
                      fontWeight: '700',
                    }}
                  >
                    {w.name} {active ? '✓' : ''}
                  </Text>
                  {(w.city || w.state) && (
                    <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 3 }}>
                      {[w.city, w.state].filter(Boolean).join(', ')}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>

          {!mustChoose && (
            <Pressable
              onPress={closeSwitcher}
              style={{ paddingVertical: 14, alignItems: 'center' }}
            >
              <Text style={{ color: colors.textMuted, fontSize: 15 }}>Cancel</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

/** Header pill showing the active location. Hidden for single-location operators. */
export function WarehouseHeaderButton() {
  const { warehouse, openSwitcher, multiLocation } = useWarehouse();
  if (!multiLocation) return null;

  const chosen = warehouse !== null;
  return (
    <Pressable
      onPress={openSwitcher}
      hitSlop={10}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 6,
        paddingHorizontal: 12,
        marginRight: 6,
        borderRadius: 999,
        backgroundColor: chosen ? colors.primaryDim : colors.surface,
        borderWidth: 1,
        // Un-chosen is a warning state, not a neutral one — work done without a
        // location is work that could land in the wrong building.
        borderColor: chosen ? colors.primary : colors.border,
      }}
    >
      <Text style={{ fontSize: 13 }}>📍</Text>
      <Text
        numberOfLines={1}
        style={{
          maxWidth: 110,
          color: chosen ? colors.primary : colors.textMuted,
          fontSize: 13,
          fontWeight: '700',
        }}
      >
        {chosen ? warehouse!.name : 'Set location'}
      </Text>
    </Pressable>
  );
}

/**
 * Full-screen block for warehouse-scoped screens when no location is chosen.
 * Screens use this instead of running an operator-wide query, so "no selection"
 * can never silently mean "show me both buildings".
 */
export function RequireWarehouse({ children }: { children: React.ReactNode }) {
  const { warehouse, ready, multiLocation, openSwitcher } = useWarehouse();
  if (!ready) return null;
  if (warehouse || !multiLocation) return <>{children}</>;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: 'center' }}>
      <Text style={{ color: colors.text, fontSize: 20, fontWeight: '800', marginBottom: 8 }}>
        Pick a location first
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 14, lineHeight: 21, marginBottom: 20 }}>
        This screen shows bins and lots for one building. Choose which location
        you&apos;re at so you don&apos;t see another warehouse&apos;s stock.
      </Text>
      <Pressable
        onPress={openSwitcher}
        style={{
          backgroundColor: colors.primary,
          paddingVertical: 14,
          borderRadius: 10,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Choose location</Text>
      </Pressable>
    </View>
  );
}
