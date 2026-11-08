// Relot for a lot in status 'refunded' (mig 0475). The floor shares one login,
// so a manager approves with their PIN, the staff member types their name and
// a reason, and relist_refunded_lot() checks everything again and writes the
// audit row. The new copy lands in inventory, unscheduled, like any relot.

import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { supabase } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import {
  managersOnly,
  relistAfterRefundInputError,
  relistAfterRefundMessage,
  type RelistAfterRefundResult,
} from '@/lib/relist-after-refund';

type Worker = { id: string; display_name: string; role: string };

export function RefundedRelistForm({
  lotId,
  operatorId,
  onDone,
}: {
  lotId: string;
  operatorId: string;
  onDone: (result: RelistAfterRefundResult) => void;
}) {
  const [managers, setManagers] = useState<Worker[] | null>(null);
  const [managerId, setManagerId] = useState('');
  const [pin, setPin] = useState('');
  const [staffName, setStaffName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void supabase.rpc('list_active_workers', { p_operator_id: operatorId }).then(({ data, error: e }) => {
      if (!alive) return;
      if (e) {
        setManagers([]);
        setError(`Couldn't load managers: ${e.message}`);
        return;
      }
      setManagers(managersOnly((data ?? []) as Worker[]));
    });
    return () => {
      alive = false;
    };
  }, [operatorId]);

  async function submit() {
    if (busy) return;
    setError(null);
    const inputError = relistAfterRefundInputError({ managerId, pin, staffName, reason });
    if (inputError) {
      setError(inputError);
      return;
    }
    setBusy(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('relist_refunded_lot', {
        p_lot_id: lotId,
        p_manager_worker_id: managerId,
        p_pin: pin.trim(),
        p_staff_name: staffName.trim(),
        p_reason: reason.trim(),
        p_auction_id: null,
      });
      setPin('');
      if (rpcErr) {
        setError(`Relist failed: ${rpcErr.message}. Nothing changed.`);
        return;
      }
      const result = data as RelistAfterRefundResult;
      if (!result?.ok || !result.lot_id) {
        setError(relistAfterRefundMessage(result));
        return;
      }
      onDone(result);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: colors.text, fontSize: 13, lineHeight: 19 }}>
        This sale was refunded and the item never left. Check the box is on its shelf and
        sellable. A manager approves with their PIN; your name and the reason go in the audit log.
      </Text>

      <Text style={s.label}>Manager approving</Text>
      {managers === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : managers.length === 0 ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>No active manager found.</Text>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {managers.map((m) => (
            <Pressable
              key={m.id}
              onPress={() => setManagerId(m.id)}
              style={[s.chip, managerId === m.id && s.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: managerId === m.id }}
            >
              <Text style={{ color: managerId === m.id ? '#000' : colors.text, fontWeight: '800', fontSize: 13 }}>
                {m.display_name}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <Text style={s.label}>Manager PIN</Text>
      <TextInput
        value={pin}
        onChangeText={setPin}
        secureTextEntry
        keyboardType="number-pad"
        autoComplete="off"
        maxLength={8}
        style={s.input}
      />

      <Text style={s.label}>Your name</Text>
      <TextInput value={staffName} onChangeText={setStaffName} autoCorrect={false} maxLength={80} style={s.input} />

      <Text style={s.label}>Why it can be sold again</Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={500}
        placeholder="e.g. box on 10-03-01, undamaged, buyer changed their mind"
        placeholderTextColor={colors.textMuted}
        style={[s.input, { minHeight: 60, textAlignVertical: 'top' }]}
      />

      {error && <Text style={{ color: colors.danger, fontSize: 13, lineHeight: 19 }}>{error}</Text>}

      <Pressable onPress={() => void submit()} disabled={busy} style={[s.primaryBtn, busy && { opacity: 0.5 }]}>
        {busy ? <ActivityIndicator color="#000" /> : <Text style={s.primaryBtnText}>Put back in inventory</Text>}
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  label: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 15,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  primaryBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '900',
  },
});
