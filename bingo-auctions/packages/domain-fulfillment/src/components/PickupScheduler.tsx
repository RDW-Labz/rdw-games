// Slot picker for invoice pickup. Calls get_pickup_slots() to enumerate
// available appointment windows, then schedule_pickup() to reserve one.
//
// Cosmetic: groups slots by day; tappable cards show remaining capacity.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { supabase } from '@auction-platform/supabase-client';
import { track } from '@auction-platform/supabase-client';

type Slot = {
  starts_at: string;
  ends_at: string;
  remaining_capacity: number;
};

type ScheduleResult = {
  ok: boolean;
  reason: string;
  pickup_id: string | null;
  scheduled_at: string | null;
};

const REASON_MESSAGES: Record<string, string> = {
  invoice_not_paid: 'Pay your invoice first.',
  outside_pickup_window: 'That slot is outside the pickup window.',
  slot_full: 'That slot just filled — pick another.',
  invoice_not_found: 'Invoice not found.',
  not_authenticated: 'Sign in again.',
};

const DEFAULT_TZ = 'America/Chicago';

function safeTimeZone(tz?: string | null): string {
  return tz && tz.length > 0 ? tz : DEFAULT_TZ;
}

export function PickupScheduler({
  invoiceId,
  currentScheduledAt,
  onScheduled,
  timeZone,
}: {
  invoiceId: string;
  currentScheduledAt: string | null;
  onScheduled: () => void;
  /** IANA timezone for the auction's warehouse (e.g. 'America/Chicago').
   *  Slot times are displayed in warehouse local time so the bidder
   *  sees the wall-clock time that matches the physical location. */
  timeZone?: string | null;
}) {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_pickup_slots', { p_invoice_id: invoiceId });
    if (error) {
      Alert.alert('Couldn\'t load slots', error.message);
      setLoading(false);
      return;
    }
    setSlots(((data as Slot[]) ?? []).filter((s) => s.remaining_capacity > 0));
    setLoading(false);
  }, [invoiceId]);

  useEffect(() => {
    load();
  }, [load]);

  async function pick(slot: Slot) {
    setSubmitting(slot.starts_at);
    const { data, error } = await supabase.rpc('schedule_pickup', {
      p_invoice_id: invoiceId,
      p_slot_starts_at: slot.starts_at,
    });
    setSubmitting(null);
    if (error) {
      Alert.alert('Couldn\'t schedule', error.message);
      return;
    }
    const result = data as unknown as ScheduleResult;
    if (!result.ok) {
      Alert.alert('Couldn\'t schedule', REASON_MESSAGES[result.reason] ?? result.reason);
      track('pickup_schedule_failed', { invoice_id: invoiceId, reason: result.reason });
      load();
      return;
    }
    track('pickup_scheduled', {
      invoice_id: invoiceId,
      scheduled_at: result.scheduled_at,
    });
    onScheduled();
  }

  const grouped = groupByDay(slots ?? [], timeZone);

  return (
    <View style={{ marginTop: 8 }}>
      {currentScheduledAt && (
        <View
          style={{
            padding: 12,
            backgroundColor: 'rgba(52, 211, 154, 0.1)',
            borderColor: '#34d39a',
            borderWidth: 1,
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          <Text style={{ color: '#34d39a', fontWeight: '600' }}>Scheduled</Text>
          <Text style={{ color: '#e8eaf0', marginTop: 4 }}>
            {formatScheduled(currentScheduledAt, timeZone)}
          </Text>
          <Text style={{ color: '#8a93a6', marginTop: 4, fontSize: 13 }}>
            Pick a different slot below to reschedule.
          </Text>
        </View>
      )}
      {loading ? (
        <ActivityIndicator color="#8a93a6" />
      ) : !slots?.length ? (
        <Text style={{ color: '#8a93a6' }}>
          No slots available right now. Check back soon, or contact the operator.
        </Text>
      ) : (
        <ScrollView style={{ maxHeight: 360 }}>
          {grouped.map(([day, daySlots]) => (
            <View key={day} style={{ marginBottom: 16 }}>
              <Text
                style={{
                  color: '#8a93a6',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 6,
                }}
              >
                {day}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {daySlots.map((s) => {
                  const busy = submitting === s.starts_at;
                  return (
                    <Pressable
                      key={s.starts_at}
                      onPress={() => pick(s)}
                      disabled={busy}
                      style={{
                        paddingVertical: 8,
                        paddingHorizontal: 12,
                        backgroundColor: '#14171f',
                        borderColor: '#232839',
                        borderWidth: 1,
                        borderRadius: 6,
                        opacity: busy ? 0.5 : 1,
                      }}
                    >
                      <Text style={{ color: '#e8eaf0', fontWeight: '500' }}>
                        {formatHm(s.starts_at, timeZone)}
                      </Text>
                      <Text style={{ color: '#8a93a6', fontSize: 11, marginTop: 2 }}>
                        {s.remaining_capacity} left
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function groupByDay(slots: Slot[], timeZone?: string | null): Array<[string, Slot[]]> {
  const tz = safeTimeZone(timeZone);
  const map = new Map<string, Slot[]>();
  for (const s of slots) {
    const key = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: tz,
    }).format(new Date(s.starts_at));
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return Array.from(map.entries());
}

function formatHm(iso: string, timeZone?: string | null): string {
  const tz = safeTimeZone(timeZone);
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  }).format(new Date(iso));
}

function formatScheduled(iso: string, timeZone?: string | null): string {
  const tz = safeTimeZone(timeZone);
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
