// Bidder-side dispute capture.
//
// Flow:
//   1. Take 1+ photos of the issue (camera).
//   2. Write a short reason.
//   3. Upload photos to dispute-photos bucket at <bidder_id>/<dispute_id>/.
//      Since dispute_id doesn't exist until INSERT, we generate a UUID
//      client-side, use it as both the storage prefix and dispute.id.
//   4. INSERT dispute row.
//
// Operator triages from /disputes in the operator console.

import { useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  Image,
  Alert,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, router } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { supabase } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import { track } from '@/lib/posthog';
import { uploadImageFromUri } from '@/lib/upload-image';

export default function NewDisputeScreen() {
  const { lotId, invoiceId } = useLocalSearchParams<{ lotId: string; invoiceId: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const [photoUris, setPhotoUris] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const cameraRef = useRef<CameraView | null>(null);

  async function takePhoto() {
    if (!cameraRef.current) return;
    setBusy(true);
    try {
      const pic = await cameraRef.current.takePictureAsync({ quality: 0.6 });
      if (pic?.uri) setPhotoUris((prev) => [...prev, pic.uri]);
    } catch (err) {
      Alert.alert('Capture failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!lotId || !invoiceId) {
      Alert.alert('Missing context', 'Open this from a pickup or invoice screen.');
      return;
    }
    if (reason.trim().length < 10) {
      Alert.alert('Add detail', 'Tell the operator what was wrong (10 chars minimum).');
      return;
    }
    if (photoUris.length === 0) {
      Alert.alert('Add a photo', 'A photo helps the operator resolve faster.');
      return;
    }

    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      Alert.alert('Sign in', 'Your session expired.');
      return;
    }

    setBusy(true);
    try {
      const disputeId = Crypto.randomUUID();
      const uploadedUrls: string[] = [];

      for (let i = 0; i < photoUris.length; i++) {
        const uri = photoUris[i]!;
        const path = `${u.user.id}/${disputeId}/${i}.jpg`;
        const upload = await uploadImageFromUri('dispute-photos', path, uri, {
          contentType: 'image/jpeg',
          upsert: true,
        });
        if (!upload.ok) throw new Error(upload.reason);
        uploadedUrls.push(upload.url);
      }

      // Look up operator_id via the invoice
      const { data: inv } = await supabase
        .from('invoices')
        .select('operator_id')
        .eq('id', invoiceId)
        .single();
      if (!inv) throw new Error('invoice not found');

      const { error: insErr } = await supabase.from('disputes').insert({
        id: disputeId,
        operator_id: inv.operator_id,
        invoice_id: invoiceId,
        lot_id: lotId,
        bidder_id: u.user.id,
        status: 'open',
        reason: reason.trim(),
        bidder_photo_urls: uploadedUrls,
      });
      if (insErr) throw insErr;

      track('dispute_opened', {
        dispute_id: disputeId,
        invoice_id: invoiceId,
        lot_id: lotId,
        photo_count: uploadedUrls.length,
      });
      Alert.alert('Submitted', 'The operator was notified. You\'ll get a push when they respond.');
      router.back();
    } catch (err) {
      Alert.alert('Submit failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!permission?.granted) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: colors.bg }}>
        <Text style={{ color: '#e8eaf0', fontSize: 16, marginBottom: 12 }}>
          Camera access lets you attach photo evidence to your report.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={{ padding: 14, backgroundColor: '#4f8cff', borderRadius: 6 }}
        >
          <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '600' }}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.bg }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
    >
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 64 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ color: '#e8eaf0', fontSize: 22, fontWeight: '700' }}>Report a problem</Text>
      <Text style={{ color: '#8a93a6', marginTop: 8, lineHeight: 20 }}>
        Tell the operator what was wrong with this item. They&apos;ll review your photos and decide
        whether to refund, partially refund, or deny.
      </Text>

      <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase', marginTop: 24 }}>
        Photos ({photoUris.length})
      </Text>
      <View
        accessibilityLiveRegion="polite"
        accessibilityLabel={
          photoUris.length === 0
            ? 'No photos attached'
            : photoUris.length === 1
              ? '1 photo attached'
              : `${photoUris.length} photos attached`
        }
      >
        <Text style={{ height: 0, width: 0, overflow: 'hidden' }}>
          {photoUris.length === 0
            ? 'No photos attached'
            : photoUris.length === 1
              ? '1 photo attached'
              : `${photoUris.length} photos attached`}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {photoUris.map((uri, i) => (
          <View key={uri} style={{ position: 'relative' }}>
            <Image source={{ uri }} style={{ width: 80, height: 80, borderRadius: 6 }} />
            <Pressable
              onPress={() => setPhotoUris((prev) => prev.filter((_, idx) => idx !== i))}
              accessibilityLabel="Remove photo"
              accessibilityRole="button"
              hitSlop={11}
              style={{
                position: 'absolute',
                top: -6,
                right: -6,
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  backgroundColor: '#ff5470',
                  borderRadius: 11,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>×</Text>
              </View>
            </Pressable>
          </View>
        ))}
      </View>

      {capturing ? (
        <View style={{ marginTop: 12 }}>
          <CameraView
            ref={cameraRef}
            style={{ height: 320, borderRadius: 8, overflow: 'hidden' }}
            facing="back"
          />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Pressable
              onPress={takePhoto}
              disabled={busy}
              style={{ flex: 1, padding: 14, backgroundColor: '#4f8cff', borderRadius: 6 }}
            >
              <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '600' }}>
                {busy ? '…' : 'Capture'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setCapturing(false)}
              style={{ flex: 1, padding: 14, backgroundColor: '#232839', borderRadius: 6 }}
            >
              <Text style={{ color: '#8a93a6', textAlign: 'center' }}>Done</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={() => setCapturing(true)}
          style={{ marginTop: 12, padding: 14, borderColor: '#232839', borderWidth: 1, borderRadius: 6 }}
        >
          <Text style={{ color: '#4f8cff', textAlign: 'center', fontWeight: '600' }}>
            + Add photo
          </Text>
        </Pressable>
      )}

      <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase', marginTop: 24 }}>
        What was wrong?
      </Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="e.g. The TV had a cracked screen that wasn't shown in the listing photos."
        placeholderTextColor="#8a93a6"
        multiline
        textAlignVertical="top"
        style={{
          marginTop: 8,
          backgroundColor: '#1c2e49',
          borderColor: '#232839',
          borderWidth: 1,
          borderRadius: 6,
          padding: 12,
          color: '#e8eaf0',
          minHeight: 120,
        }}
      />

      <Pressable
        onPress={submit}
        disabled={busy || photoUris.length === 0 || reason.trim().length < 10}
        style={{
          marginTop: 24,
          padding: 16,
          backgroundColor: '#4f8cff',
          borderRadius: 8,
          opacity: busy || photoUris.length === 0 || reason.trim().length < 10 ? 0.5 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={{ color: '#fff', fontWeight: '700', textAlign: 'center', fontSize: 16 }}>
            Submit dispute
          </Text>
        )}
      </Pressable>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}
