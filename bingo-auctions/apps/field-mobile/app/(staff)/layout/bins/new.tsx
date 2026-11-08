// /bins/new — mobile bin generator.
//
// Why this exists: until this commit, the only way to create bins was
// operator-web's /warehouses/[id]/bins page. The /bins mobile list
// view had no creation affordance and its empty-state copy pointed
// to "the Warehouse layout screen" — which doesn't create bins.
// Operators standing in a real warehouse couldn't generate QR codes
// without bouncing to a desktop.
//
// Mirrors operator-web's BinForm bulk mode (parseRange + the
// aisle × bays × levels × positions cross-product). The bulk path is
// the dominant use case — operators almost always lay out an entire
// aisle at once, not a single bin.
//
// Generation algorithm matches actions.ts createBinsBulk EXACTLY so
// codes line up across the two surfaces:
//   code = `${aisle}-${bay.padStart(2,'0')}-${level}-${position.padStart(2,'0')}`
//   x_px = 100 + bayIdx * 200 + position * 50
//   y_px = 100 + level * 100
// Operator drag-to-place on the floor plan still happens on
// operator-web.

import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import { useWarehouse } from '@/features/location/WarehouseContext';

type Warehouse = { id: string; name: string };

// Parses "1-10" or "1,3,5" into a list of numbers.
// Mirrors operator-web's parseRange at actions.ts:33 exactly.
function parseRange(spec: string): number[] {
  const trimmed = spec.trim();
  if (!trimmed) return [];
  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);
  }
  const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m && m[1] && m[2]) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo > hi) return [];
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? [n] : [];
}

// Build the same bin grid the operator-web BinForm bulk would.
// Returns the rows ready to INSERT and the human-readable preview
// (e.g. "A-01-1-01, A-02-1-01, …, A-10-1-01").
function buildBinRows(input: {
  warehouseId: string;
  aisle: string;
  bays: string;
  levels: string;
  positions: string;
}): {
  rows: Array<{
    warehouse_id: string;
    code: string;
    aisle: string;
    bay: string;
    level: number;
    position: number;
    x_px: number;
    y_px: number;
  }>;
  preview: string[];
} {
  const bays = parseRange(input.bays);
  const levels = parseRange(input.levels);
  const positions = parseRange(input.positions);
  const aisle = input.aisle.trim();

  if (!aisle || !bays.length || !levels.length || !positions.length) {
    return { rows: [], preview: [] };
  }

  const rows: ReturnType<typeof buildBinRows>['rows'] = [];
  let bayIdx = 0;
  for (const bay of bays) {
    for (const level of levels) {
      for (const position of positions) {
        const code = `${aisle}-${String(bay).padStart(2, '0')}-${level}-${String(position).padStart(2, '0')}`;
        rows.push({
          warehouse_id: input.warehouseId,
          code,
          aisle,
          bay: String(bay).padStart(2, '0'),
          level,
          position,
          x_px: 100 + bayIdx * 200 + position * 50,
          y_px: 100 + level * 100,
        });
      }
    }
    bayIdx++;
  }

  return {
    rows,
    preview: rows.map((r) => r.code),
  };
}

export default function NewBinsScreen() {
  const router = useRouter();
  const role = useOperatorRole();

  // 0293: the building this device is working in, used to seed the picker below.
  const { warehouse: activeWarehouse } = useWarehouse();

  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);

  const [aisle, setAisle] = useState('A');
  const [bays, setBays] = useState('1-10');
  // Sensible defaults for most warehouses: 1 level, 1 position per bay.
  // The operator can expand the advanced section to override.
  const [levels, setLevels] = useState('1');
  const [positions, setPositions] = useState('1');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load operator's warehouses for the picker. RLS scopes automatically.
  useEffect(() => {
    if (role.kind !== 'staff') return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('warehouses')
        .select('id, name')
        .order('name', { ascending: true });
      if (cancelled) return;
      const list = (data ?? []) as Warehouse[];
      setWarehouses(list);
      // 0293 / multi-location audit: seed from the device's ACTIVE location, not
      // list[0]. This screen CREATES bins — defaulting to the first warehouse
      // meant a worker standing in Dodge City silently generated Harrison bin
      // codes. Fall back to list[0] only when there is exactly one warehouse.
      if (!warehouseId) {
        if (activeWarehouse) setWarehouseId(activeWarehouse.id);
        else if (list.length === 1) setWarehouseId(list[0]!.id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // activeWarehouse is in the deps because WarehouseContext hydrates from
    // AsyncStorage asynchronously — it is frequently still null on this
    // effect's first run, and without a re-run the picker would fall back to
    // showing nothing selected (or, pre-0293, to the wrong warehouse).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, activeWarehouse]);

  // Recompute the preview on every input change. Cheap — the cross
  // product is bounded by the operator's typing (usually <100 bins).
  const { rows, preview } = useMemo(
    () =>
      warehouseId
        ? buildBinRows({ warehouseId, aisle, bays, levels, positions })
        : { rows: [], preview: [] },
    [warehouseId, aisle, bays, levels, positions],
  );

  const canSubmit = !!warehouseId && rows.length > 0 && !submitting;

  async function handleCreate() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      // Track C #11: route through create_bins_bulk (migration 0065)
      // instead of a raw INSERT. The RPC handles parsing + grid math
      // server-side (single source of truth, same algorithm as
      // operator-web's BinForm), reports per-bin status so we can
      // tell the operator which codes succeeded vs duplicated, and
      // gives us a place to add future validation without touching
      // mobile.
      const { data, error: rpcErr } = await supabase.rpc('create_bins_bulk', {
        p_warehouse_id: warehouseId,
        p_aisle: aisle,
        p_bays: bays,
        p_levels: levels,
        p_positions: positions,
      });
      if (rpcErr) {
        // Server-side validation errors come back here. Translate the
        // common ones to operator-friendly copy.
        const m = rpcErr.message;
        const userMsg =
          /aisle_invalid_length/.test(m)
            ? 'Aisle must be 1-20 characters.'
            : /range_invalid/.test(m)
              ? 'Bays / levels / positions must each contain at least one number.'
              : /admin_or_manager_required|warehouse_other_operator|not_staff/.test(m)
                ? "You don't have permission to create bins in this warehouse."
                : /warehouse_not_found/.test(m)
                  ? 'Warehouse not found — try refreshing.'
                  : m;
        setError(userMsg);
        return;
      }

      type RpcRow = { code: string; ok: boolean; error: string | null };
      const result = (data ?? []) as RpcRow[];
      const succeeded = result.filter((r) => r.ok).length;
      const duplicates = result.filter((r) => !r.ok && r.error === 'duplicate').length;
      const otherFailed = result.filter((r) => !r.ok && r.error !== 'duplicate').length;

      if (succeeded === 0) {
        setError(
          duplicates > 0
            ? `All ${duplicates} bin code${duplicates === 1 ? '' : 's'} already exist in this warehouse. Try a different aisle or bay range.`
            : 'No bins were created.',
        );
        return;
      }

      const messageParts: string[] = [
        `${succeeded} bin${succeeded === 1 ? '' : 's'} generated.`,
      ];
      if (duplicates > 0)
        messageParts.push(`${duplicates} skipped (already existed).`);
      if (otherFailed > 0)
        messageParts.push(`${otherFailed} failed — see logs.`);

      Alert.alert('Bins created', messageParts.join(' '), [
        { text: 'View QR codes', onPress: () => router.replace('/layout/bins') },
      ]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (role.kind !== 'staff') return null;

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <View>
          <Text style={s.headerEyebrow}>NEW BINS</Text>
          <Text style={s.headerTitle}>Generate QR codes</Text>
        </View>
        <Pressable onPress={() => router.back()} style={s.cancelBtn} hitSlop={12}>
          <Text style={s.cancelBtnText}>Cancel</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={{ padding: 14, gap: 14, paddingBottom: 80 }}>
          {/* Warehouse picker */}
          <View style={s.field}>
            <Text style={s.fieldLabel}>Warehouse</Text>
            {warehouses === null ? (
              <ActivityIndicator color={colors.primary} />
            ) : warehouses.length === 0 ? (
              <Text style={s.hint}>
                No warehouses yet. Create one from operator-web first.
              </Text>
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {warehouses.map((w) => {
                  const active = w.id === warehouseId;
                  return (
                    <Pressable
                      key={w.id}
                      onPress={() => setWarehouseId(w.id)}
                      style={[s.chip, active && s.chipActive]}
                    >
                      <Text style={[s.chipText, active && s.chipTextActive]}>
                        {w.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          {/* Aisle */}
          <View style={s.field}>
            <Text style={s.fieldLabel}>Aisle</Text>
            <Text style={s.hint}>Letter or short label — A, B, MAIN, etc.</Text>
            <TextInput
              value={aisle}
              onChangeText={setAisle}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={20}
              style={s.input}
              placeholder="A"
              placeholderTextColor={colors.textMuted}
            />
          </View>

          {/* Bays */}
          <View style={s.field}>
            <Text style={s.fieldLabel}>Bays</Text>
            <Text style={s.hint}>
              Range like &quot;1-10&quot; or list like &quot;1,3,5&quot;.
              Each bay gets its own bin.
            </Text>
            <TextInput
              value={bays}
              onChangeText={setBays}
              autoCorrect={false}
              keyboardType="default"
              style={s.input}
              placeholder="1-10"
              placeholderTextColor={colors.textMuted}
            />
          </View>

          {/* Advanced toggle */}
          <Pressable onPress={() => setShowAdvanced((v) => !v)}>
            <Text style={s.advancedToggle}>
              {showAdvanced ? '▾' : '▸'} Advanced — multiple levels or positions per bay
            </Text>
          </Pressable>

          {showAdvanced && (
            <>
              <View style={s.field}>
                <Text style={s.fieldLabel}>Levels per bay</Text>
                <Text style={s.hint}>
                  Stacked shelves. Default 1 = ground level only.
                </Text>
                <TextInput
                  value={levels}
                  onChangeText={setLevels}
                  autoCorrect={false}
                  keyboardType="default"
                  style={s.input}
                  placeholder="1"
                  placeholderTextColor={colors.textMuted}
                />
              </View>
              <View style={s.field}>
                <Text style={s.fieldLabel}>Positions per bay-level</Text>
                <Text style={s.hint}>
                  Slots within a single shelf. Default 1 = whole bay is one bin.
                </Text>
                <TextInput
                  value={positions}
                  onChangeText={setPositions}
                  autoCorrect={false}
                  keyboardType="default"
                  style={s.input}
                  placeholder="1"
                  placeholderTextColor={colors.textMuted}
                />
              </View>
            </>
          )}

          {/* Preview */}
          {rows.length > 0 ? (
            <View style={s.preview}>
              <Text style={s.previewHeading}>
                Will create {rows.length} bin{rows.length === 1 ? '' : 's'}
              </Text>
              <Text style={s.previewBody}>
                {preview.slice(0, 8).join(' · ')}
                {preview.length > 8 ? ` · …+${preview.length - 8} more` : ''}
              </Text>
            </View>
          ) : (
            <View style={[s.preview, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <Text style={[s.previewHeading, { color: colors.textMuted }]}>
                Fill the fields above to see the preview.
              </Text>
            </View>
          )}

          {error && (
            <View style={s.errorBox}>
              <Text style={s.errorText}>{error}</Text>
            </View>
          )}

          {/* Submit */}
          <Pressable
            onPress={handleCreate}
            disabled={!canSubmit}
            style={[s.submit, !canSubmit && { opacity: 0.4 }]}
          >
            {submitting ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text style={s.submitText}>
                ✓ Generate {rows.length || 0} bin QR code{rows.length === 1 ? '' : 's'}
              </Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerEyebrow: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  headerTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.4,
  },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelBtnText: { color: colors.textMuted, fontSize: 14, fontWeight: '700' },
  field: { gap: 6 },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  input: {
    padding: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    color: colors.text,
    fontSize: 15,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: {
    borderColor: colors.primary,
    backgroundColor: 'rgba(255,122,0,0.12)',
  },
  chipText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: colors.primary },
  advancedToggle: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  preview: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: 'rgba(255,122,0,0.08)',
    gap: 4,
  },
  previewHeading: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '900',
  },
  previewBody: {
    color: colors.text,
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  errorBox: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: 'rgba(239,68,68,0.1)',
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '700',
  },
  submit: {
    padding: 16,
    backgroundColor: colors.primary,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '900',
  },
});
