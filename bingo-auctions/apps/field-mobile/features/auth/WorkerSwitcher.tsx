// In-app worker clock-in / switch-employee sheet + header button (#2 revision
// 2026-07-23). Replaces the old blocking ClockInGate.
//
// Field feedback (Jerrod): forcing a PIN right after the shared-phone login
// wasn't realistic. So the app no longer gates on a clock-in — it opens
// straight to work. Instead a small "worker" button lives in the header of
// every staff screen (WorkerHeaderButton); tapping it opens this sheet to clock
// in, switch employee, or clock out at any time, from anywhere in the app.
//
// Attribution (lots.lotted_by_worker) + role-gating (useEffectiveRole) still
// apply whenever someone is clocked in; they simply aren't forced.

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import { useActiveWorker } from './WorkerContext';

type WorkerRow = { id: string; display_name: string; role: string };
const PIN_MIN = 4;
const PIN_MAX = 8;

// Pick a name, punch a PIN on a big on-screen keypad (no OS keyboard — better on
// a shared tablet), verify_worker_pin (bcrypt + lockout, mig 0281) clocks them
// in. Calls onDone() after a successful clock-in so the sheet can close.
function WorkerPinPicker({
  workers,
  onDone,
}: {
  workers: WorkerRow[];
  onDone: () => void;
}) {
  const { clockIn } = useActiveWorker();
  const [selected, setSelected] = useState<WorkerRow | null>(null);
  const [pin, setPin] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [pinErr, setPinErr] = useState<string | null>(null);

  const pick = useCallback((w: WorkerRow) => {
    setSelected(w);
    setPin('');
    setPinErr(null);
    void Haptics.selectionAsync();
  }, []);

  const tap = useCallback((d: string) => {
    setPinErr(null);
    setPin((p) => (p.length >= PIN_MAX ? p : p + d));
    void Haptics.selectionAsync();
  }, []);

  const del = useCallback(() => setPin((p) => p.slice(0, -1)), []);

  const submit = useCallback(async () => {
    if (!selected || verifying || pin.length < PIN_MIN) return;
    setVerifying(true);
    setPinErr(null);
    try {
      const { data, error } = await supabase.rpc('verify_worker_pin', {
        p_worker_id: selected.id,
        p_pin: pin,
      });
      if (error) throw new Error(error.message);
      const res = data as {
        ok?: boolean;
        reason?: string;
        worker?: { id: string; display_name: string; role: string; operator_id: string };
      } | null;
      if (res?.ok && res.worker) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        clockIn({
          id: res.worker.id,
          displayName: res.worker.display_name,
          role: res.worker.role,
          operatorId: res.worker.operator_id,
        });
        onDone();
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPin('');
      setPinErr(
        res?.reason === 'locked'
          ? 'Locked after too many tries — wait a few minutes or ask a manager.'
          : res?.reason === 'not_found'
            ? 'That worker is no longer active — pick another name.'
            : 'Wrong PIN — try again.',
      );
    } catch (e) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPinErr((e as Error).message);
    } finally {
      setVerifying(false);
    }
  }, [selected, pin, verifying, clockIn, onDone]);

  if (!selected) {
    return (
      <View style={{ flex: 1, padding: 20 }}>
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: '900', marginBottom: 4 }}>
          Who&apos;s working?
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 13, marginBottom: 20 }}>
          Tap your name, then enter your PIN.
        </Text>
        <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {workers.map((w) => (
            <Pressable
              key={w.id}
              onPress={() => pick(w)}
              style={{
                backgroundColor: colors.surface,
                borderRadius: 12,
                paddingVertical: 22,
                paddingHorizontal: 18,
                minWidth: '46%',
                flexGrow: 1,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>{w.display_name}</Text>
              {w.role !== 'picker' && (
                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4, textTransform: 'capitalize' }}>
                  {w.role}
                </Text>
              )}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    );
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  const dotCount = Math.max(PIN_MIN, pin.length);
  return (
    <View style={{ flex: 1, padding: 20, alignItems: 'center' }}>
      <Pressable
        onPress={() => {
          setSelected(null);
          setPin('');
          setPinErr(null);
        }}
        hitSlop={10}
        style={{ alignSelf: 'flex-start' }}
      >
        <Text style={{ color: colors.primary, fontWeight: '700' }}>‹ Not you? Pick a name</Text>
      </Pressable>
      <Text style={{ color: colors.text, fontSize: 22, fontWeight: '900', marginTop: 12 }}>
        {selected.display_name}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 4, marginBottom: 22 }}>Enter your PIN</Text>
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 6 }}>
        {Array.from({ length: dotCount }, (_, i) => (
          <View
            key={i}
            style={{
              width: 14,
              height: 14,
              borderRadius: 7,
              backgroundColor: i < pin.length ? colors.primary : 'transparent',
              borderWidth: 1.5,
              borderColor: i < pin.length ? colors.primary : colors.border,
            }}
          />
        ))}
      </View>
      <Text style={{ color: colors.danger, fontSize: 13, minHeight: 20, marginBottom: 12, textAlign: 'center' }}>
        {pinErr ?? ''}
      </Text>
      <View style={{ width: 260, flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
        {keys.map((k, i) =>
          k === '' ? (
            <View key={i} style={{ width: 76, height: 64 }} />
          ) : (
            <Pressable
              key={i}
              onPress={() => (k === '⌫' ? del() : tap(k))}
              disabled={verifying}
              style={{
                width: 76,
                height: 64,
                borderRadius: 12,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: colors.text, fontSize: 24, fontWeight: '800' }}>{k}</Text>
            </Pressable>
          ),
        )}
      </View>
      <Pressable
        onPress={() => void submit()}
        disabled={verifying || pin.length < PIN_MIN}
        style={{
          marginTop: 22,
          width: 260,
          paddingVertical: 16,
          borderRadius: 12,
          backgroundColor: colors.primary,
          alignItems: 'center',
          opacity: verifying || pin.length < PIN_MIN ? 0.5 : 1,
        }}
      >
        <Text style={{ color: '#000', fontWeight: '900', fontSize: 16 }}>
          {verifying ? 'Checking…' : 'Clock in'}
        </Text>
      </Pressable>
    </View>
  );
}

// The sheet itself — controlled by WorkerContext.switcherOpen. Loads the
// operator's active-worker roster on open. If nobody is clocked in it goes
// straight to the picker; if someone is, it shows a menu (switch / clock out).
export function WorkerSwitcher() {
  const role = useOperatorRole();
  const operatorId = role.kind === 'staff' ? role.operatorId : null;
  const { worker, clockOut, switcherOpen, closeSwitcher } = useActiveWorker();
  const [roster, setRoster] = useState<WorkerRow[] | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!switcherOpen || !operatorId) return;
    // Reset the internal view each time the sheet opens: menu when someone is
    // clocked in, straight to the picker when nobody is.
    setPicking(!worker);
    setRoster(null);
    let cancelled = false;
    void supabase
      .rpc('list_active_workers', { p_operator_id: operatorId })
      .then(({ data, error }) => {
        if (cancelled) return;
        setRoster(error ? [] : ((data ?? []) as WorkerRow[]));
      });
    return () => {
      cancelled = true;
    };
  }, [switcherOpen, operatorId, worker]);

  const body = () => {
    if (roster === null) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      );
    }
    if (roster.length === 0) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '800', textAlign: 'center' }}>
            No workers set up yet
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 19 }}>
            A manager adds workers + PINs on the operator console (Staff → Manage warehouse workers).
          </Text>
        </View>
      );
    }
    if (picking || !worker) {
      return <WorkerPinPicker workers={roster} onDone={closeSwitcher} />;
    }
    // Menu view — someone is clocked in.
    return (
      <View style={{ flex: 1, padding: 20 }}>
        <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' }}>
          Clocked in
        </Text>
        <Text style={{ color: colors.text, fontSize: 24, fontWeight: '900', marginTop: 4 }}>
          {worker.displayName}
        </Text>
        {worker.role !== 'picker' && (
          <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 2, textTransform: 'capitalize' }}>
            {worker.role}
          </Text>
        )}
        <Pressable
          onPress={() => setPicking(true)}
          style={{
            marginTop: 28,
            paddingVertical: 16,
            borderRadius: 12,
            backgroundColor: colors.primary,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#000', fontWeight: '900', fontSize: 16 }}>Switch employee</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            clockOut();
            closeSwitcher();
          }}
          style={{
            marginTop: 12,
            paddingVertical: 16,
            borderRadius: 12,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>Clock out</Text>
        </Pressable>

        {/* Device sign-out (Jared 2026-07-28). Before this there was NO sign-out
            anywhere in the (staff) stack — signOut existed only on the
            not-staff bounce screen. Four screens told users to "sign out and
            back in" to refresh a stale role, advice they literally could not
            follow, and switching the shared device to a different company
            account meant reinstalling the app.

            Distinct from "Clock out": clock-out drops the per-worker PIN
            identity but keeps the device logged in (the normal end-of-shift
            action). This releases the DEVICE's shared staff login, which is why
            it is styled as a destructive last resort and asks first. */}
        <Pressable
          onPress={() => {
            Alert.alert(
              'Sign out this device?',
              'This releases the shared staff login, not just your PIN. Everyone using this device will need the staff email and password to get back in. To just end your own shift, use Clock out.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Sign out device',
                  style: 'destructive',
                  onPress: () => {
                    clockOut();
                    closeSwitcher();
                    // scope:'local' mirrors not-staff.tsx — do NOT revoke the
                    // refresh token globally, or every OTHER shared device on
                    // the same staff account gets kicked mid-shift.
                    void supabase.auth.signOut({ scope: 'local' });
                  },
                },
              ],
            );
          }}
          style={{
            marginTop: 24,
            paddingVertical: 14,
            borderRadius: 12,
            backgroundColor: 'transparent',
            borderWidth: 1,
            borderColor: colors.danger,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: colors.danger, fontWeight: '700', fontSize: 14 }}>
            Sign out this device
          </Text>
        </Pressable>
      </View>
    );
  };

  return (
    <Modal visible={switcherOpen} animationType="slide" onRequestClose={closeSwitcher}>
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: 52 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingBottom: 8,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '900' }}>Worker</Text>
          <Pressable onPress={closeSwitcher} hitSlop={12} style={{ padding: 6 }}>
            <Text style={{ color: colors.primary, fontSize: 15, fontWeight: '800' }}>Close</Text>
          </Pressable>
        </View>
        {body()}
      </View>
    </Modal>
  );
}

// The persistent header button on every staff screen: shows the clocked-in
// worker's first name (tap to switch / clock out), or "Clock in" when nobody is.
export function WorkerHeaderButton() {
  const { worker, openSwitcher } = useActiveWorker();
  const label = worker ? worker.displayName.split(' ')[0] : 'Clock in';
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
        backgroundColor: worker ? colors.primaryDim : colors.surface,
        borderWidth: 1,
        borderColor: worker ? colors.primary : colors.border,
      }}
    >
      <Text style={{ fontSize: 13 }}>👤</Text>
      <Text
        numberOfLines={1}
        style={{
          color: worker ? colors.primary : colors.textMuted,
          fontSize: 13,
          fontWeight: '800',
          maxWidth: 120,
        }}
      >
        {label}
      </Text>
      <Text style={{ color: worker ? colors.primary : colors.textMuted, fontSize: 11 }}>▾</Text>
    </Pressable>
  );
}
