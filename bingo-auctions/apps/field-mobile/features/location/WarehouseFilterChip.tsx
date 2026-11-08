// Per-screen pickup list filter: "All warehouses" (default) vs one building.
// Separate from WarehouseContext's active location — context still scopes bin
// work; this only narrows list views on checkout/worklist screens.

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors } from '@auction-platform/design-system';
import { useWarehouse, type ActiveWarehouse } from './WarehouseContext';

export function WarehouseFilterChip({
  value,
  onChange,
}: {
  /** null = all warehouses */
  value: string | null;
  onChange: (warehouseId: string | null) => void;
}) {
  const { warehouse, available, multiLocation } = useWarehouse();
  const [pickerOpen, setPickerOpen] = useState(false);

  if (!multiLocation) return null;

  const activeName =
    value === null
      ? null
      : available.find((w) => w.id === value)?.name ?? warehouse?.name ?? 'Warehouse';

  const label = value === null ? 'All warehouses' : activeName ?? 'Warehouse';

  function pick(w: ActiveWarehouse | null) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onChange(w?.id ?? null);
    setPickerOpen(false);
  }

  return (
    <>
      <Pressable
        onPress={() => {
          if (value === null) {
            if (warehouse) onChange(warehouse.id);
            else setPickerOpen(true);
          } else {
            onChange(null);
          }
        }}
        onLongPress={() => setPickerOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Warehouse filter: ${label}. Long press to choose a warehouse.`}
        style={{
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 99,
          backgroundColor: value ? colors.primaryDim : colors.surface,
          borderWidth: 1,
          borderColor: value ? colors.primary : colors.border,
          marginBottom: 8,
        }}
      >
        <Text
          style={{
            color: value ? colors.primary : colors.textMuted,
            fontSize: 12,
            fontWeight: '800',
          }}
        >
          {label}
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 10, marginLeft: 6 }}>▾</Text>
      </Pressable>

      <Modal
        visible={pickerOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 }}
          onPress={() => setPickerOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.bg,
              borderRadius: 12,
              padding: 16,
              maxHeight: '70%',
            }}
          >
            <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 12 }}>
              Filter by warehouse
            </Text>
            <ScrollView>
              <Pressable
                onPress={() => pick(null)}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                  marginBottom: 8,
                  backgroundColor: value === null ? colors.primaryDim : colors.surface,
                  borderWidth: 1,
                  borderColor: value === null ? colors.primary : colors.border,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '700' }}>All warehouses</Text>
              </Pressable>
              {available.map((w) => {
                const active = value === w.id;
                return (
                  <Pressable
                    key={w.id}
                    onPress={() => pick(w)}
                    style={{
                      paddingVertical: 14,
                      paddingHorizontal: 12,
                      borderRadius: 8,
                      marginBottom: 8,
                      backgroundColor: active ? colors.primaryDim : colors.surface,
                      borderWidth: 1,
                      borderColor: active ? colors.primary : colors.border,
                    }}
                  >
                    <Text style={{ color: active ? colors.primary : colors.text, fontWeight: '700' }}>
                      {w.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Pressable onPress={() => setPickerOpen(false)} style={{ paddingVertical: 12, alignItems: 'center' }}>
              <Text style={{ color: colors.textMuted }}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
