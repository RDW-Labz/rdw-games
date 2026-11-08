// Cross-warehouse scan warning.
//
// Reported 2026-08-14: "If I'm working under Dodge City and scan an item
// belonging to Harrison, the system shows the item details but does not warn me
// that it belongs to another location."
//
// Every scan screen resolved the lot and rendered its details without ever
// comparing lots.warehouse_id to the building the device is working in — the
// shared resolver did not even SELECT the column (fixed alongside this). So a
// Harrison box scanned in Dodge City looked completely normal, and staff had no
// signal until the item turned up missing from the other location's shelves.
//
// This is deliberately a loud block-level banner rather than a toast: the
// failure it prevents is silent and is discovered days later during pickup, so
// it has to survive being glanced past. It renders NOTHING in the ordinary case
// (item is local, or has no warehouse yet), so screens can mount it
// unconditionally.
//
// Named warehouses are resolved from the operator's own list, so this works for
// Dodge City, Harrison and any location added later with no code change.

import { View, Text, StyleSheet } from 'react-native';
import { colors } from '@auction-platform/design-system';
import { useWarehouse } from './WarehouseContext';

export interface CrossWarehouseWarningProps {
  /** lots.warehouse_id of the scanned item. NULL = not yet put away. */
  lotWarehouseId: string | null | undefined;
  /** Optional extra line, e.g. what the screen will refuse to do about it. */
  detail?: string;
}

/**
 * Returns the foreign warehouse's display name when the scanned lot belongs to
 * a DIFFERENT building than the active one, else null. Exported so screens can
 * gate an action (not just render a banner) on the same condition.
 */
export function useForeignWarehouseName(
  lotWarehouseId: string | null | undefined,
): string | null {
  const { warehouse, available, ready } = useWarehouse();

  // No active building chosen, or the list has not loaded: stay silent rather
  // than warn about a comparison we cannot actually make.
  if (!ready || !warehouse) return null;
  // Not yet put away — belongs to nowhere yet, so it is not misplaced.
  if (!lotWarehouseId) return null;
  if (lotWarehouseId === warehouse.id) return null;

  const match = available.find((w) => w.id === lotWarehouseId);
  // Fall back to a generic phrase rather than rendering a raw UUID at someone
  // holding a box: the operator may have lost visibility of that warehouse.
  return match?.name ?? 'another';
}

export function CrossWarehouseWarning({
  lotWarehouseId,
  detail,
}: CrossWarehouseWarningProps) {
  const foreign = useForeignWarehouseName(lotWarehouseId);
  if (!foreign) return null;

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.title}>This item belongs to {foreign} inventory.</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.dangerDim,
    borderColor: colors.danger,
    borderWidth: 2,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  title: {
    color: colors.dangerHi,
    fontSize: 16,
    fontWeight: '700',
  },
  detail: {
    color: colors.dangerHi,
    fontSize: 14,
    marginTop: 4,
  },
});
