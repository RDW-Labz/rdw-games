// Off-site warehouse customer_notice gate — shown before the first bid on
// lots at a warehouse with a non-empty customer_notice.

import { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import type { WarehousePickupDescribed } from '@/lib/warehouse-pickup';

export type OffsiteNoticeModalProps = {
  visible: boolean;
  pickup: WarehousePickupDescribed | null;
  warehouseId: string | null;
  onCancel: () => void;
  onAccepted: () => void;
};

export function OffsiteNoticeModal(props: OffsiteNoticeModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (!props.warehouseId) {
      props.onAccepted();
      return;
    }
    setError(null);
    setSubmitting(true);
    const { error: rpcErr } = await supabase.rpc('ack_warehouse_notice', {
      p_warehouse_id: props.warehouseId,
    });
    setSubmitting(false);
    if (rpcErr) {
      console.warn('[OffsiteNoticeModal] ack_warehouse_notice failed; proceeding', rpcErr);
      props.onAccepted();
      return;
    }
    props.onAccepted();
  }

  function cancel() {
    setError(null);
    props.onCancel();
  }

  const pickup = props.pickup;

  return (
    <Modal visible={props.visible} animationType="slide" transparent onRequestClose={cancel}>
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.65)',
          justifyContent: 'flex-end',
        }}
      >
        <View
          accessibilityViewIsModal
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            paddingTop: 12,
            paddingBottom: 18,
            maxHeight: '90%',
            borderTopWidth: 1,
            borderColor: colors.border,
          }}
        >
          <View style={{ paddingHorizontal: 18, marginBottom: 12 }}>
            <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
              {pickup?.name ?? 'Pickup location'}
            </Text>
            <Text style={{ color: colors.text, fontSize: 18, marginTop: 4, ...type.display }}>
              Off-site pickup notice
            </Text>
          </View>

          <ScrollView
            style={{ maxHeight: 360 }}
            contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 12, gap: 10 }}
          >
            {pickup?.notice && (
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '800' }}>
                {pickup.notice}
              </Text>
            )}
            {pickup?.addressLines.map((line) => (
              <Text key={line} style={{ color: colors.text, fontSize: 14 }}>
                {line}
              </Text>
            ))}
            {pickup && pickup.hoursLines.length > 0 && (
              <View>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>
                  Pickup hours
                </Text>
                {pickup.hoursLines.map((line) => (
                  <Text key={line} style={{ color: colors.text, fontSize: 14 }}>
                    {line}
                  </Text>
                ))}
              </View>
            )}
            {pickup?.instructions && (
              <View>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>
                  Instructions
                </Text>
                <Text style={{ color: colors.text, fontSize: 14 }}>{pickup.instructions}</Text>
              </View>
            )}
            {pickup?.directionsUrl && (
              <Pressable
                onPress={() => Linking.openURL(pickup.directionsUrl!).catch(() => {})}
              >
                <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '700' }}>
                  Get directions
                </Text>
              </Pressable>
            )}
          </ScrollView>

          {error && (
            <Text style={{ color: colors.danger, paddingHorizontal: 18, marginBottom: 8 }}>
              {error}
            </Text>
          )}

          <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 18, marginTop: 8 }}>
            <Pressable
              onPress={cancel}
              disabled={submitting}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.border,
                alignItems: 'center',
                opacity: submitting ? 0.5 : 1,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '700' }}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={accept}
              disabled={submitting}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: colors.primary,
                alignItems: 'center',
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text style={{ color: colors.bg, fontWeight: '800' }}>I understand — continue</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
