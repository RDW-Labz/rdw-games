// Profile > Delete Account confirmation page.
//
// Apple App Store Guideline 5.1.1(v) requires an in-app mechanism for
// deleting the account. The flow:
//   1. User taps "Delete account" on /profile
//   2. Lands here
//   3. Reads the "what will happen" list
//   4. Types their email address to confirm intent
//   5. Taps the destructive button
//   6. RPC `delete_my_account` anonymizes bidders + tombstones auth.users
//   7. App signs out + redirects to landing
//
// The RPC is idempotent (safe to call twice) and tombstones rather than
// deletes — see migration 0089 for the data-retention rationale.

import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';

export default function DeleteAccountScreen() {
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [typedEmail, setTypedEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user?.email) setAccountEmail(user.email);
    })();
  }, []);

  const isConfirmed =
    accountEmail !== null &&
    typedEmail.trim().toLowerCase() === accountEmail.trim().toLowerCase();

  async function handleDelete() {
    if (!isConfirmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: rpcErr } = await supabase.rpc('delete_my_account');
      if (rpcErr) {
        setError(rpcErr.message);
        setSubmitting(false);
        return;
      }
      // Sign out (the auth.users row is tombstoned but our cached
      // session token may still be present client-side; this nukes it).
      await supabase.auth.signOut();
      // Friendly farewell, then go to landing.
      Alert.alert(
        'Account deleted',
        'Your account has been permanently deleted. We hope to see you again sometime.',
        [{ text: 'OK', onPress: () => router.replace('/') }],
      );
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  }

  return (
    // UX-P0-3 fix (2026-05-24 audit): keyboard previously covered the
    // confirm-email TextInput + destructive button on small phones
    // (iPhone SE et al). Wrap the existing ScrollView in
    // KeyboardAvoidingView so the input stays visible while typing.
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
    <ScrollView
      style={{ flex: 1, backgroundColor: '#0a0c11' }}
      contentContainerStyle={{ padding: 20, paddingTop: 60 }}
    >
      <Text
        style={{
          color: '#f3f4f8',
          fontSize: 24,
          fontWeight: '700',
          marginBottom: 20,
        }}
      >
        Permanently delete your account?
      </Text>

      <Text
        style={{
          color: '#c0c5d0',
          fontSize: 14,
          lineHeight: 22,
          marginBottom: 20,
        }}
      >
        This action cannot be undone. Once you delete your BinGo Auctions account:
      </Text>

      <View style={{ marginBottom: 24 }}>
        {[
          'Your email, name, phone, and date of birth are removed from our records.',
          'You will no longer be able to sign in with this account.',
          'Your saved searches, watchlist, and any active bidder subscriptions are deleted.',
          'Any pending invoices are canceled.',
          'Settled invoices and bid history are retained for 7 years to satisfy tax and audit requirements, with all personal identifiers removed.',
          'You can create a new account with the same email later if you change your mind.',
        ].map((line, i) => (
          <View
            key={i}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              marginBottom: 10,
            }}
          >
            <Text style={{ color: '#8a93a6', marginRight: 8, fontSize: 14 }}>
              •
            </Text>
            <Text
              style={{
                color: '#c0c5d0',
                flex: 1,
                fontSize: 14,
                lineHeight: 22,
              }}
            >
              {line}
            </Text>
          </View>
        ))}
      </View>

      <Text
        style={{
          color: '#f3f4f8',
          fontSize: 14,
          fontWeight: '600',
          marginBottom: 8,
        }}
      >
        To confirm, type your email address:
      </Text>
      <Text style={{ color: '#8a93a6', fontSize: 13, marginBottom: 10 }}>
        {accountEmail ?? 'Loading…'}
      </Text>
      <TextInput
        value={typedEmail}
        onChangeText={setTypedEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        placeholder="Type your email to confirm"
        placeholderTextColor="#5a6276"
        style={{
          backgroundColor: '#13161e',
          borderWidth: 1,
          borderColor: '#2a3040',
          borderRadius: 6,
          padding: 12,
          color: '#f3f4f8',
          fontSize: 15,
          marginBottom: 16,
        }}
        editable={!submitting}
      />

      {error && (
        <Text
          style={{
            color: '#ff5470',
            fontSize: 13,
            marginBottom: 12,
            textAlign: 'center',
          }}
        >
          {error}
        </Text>
      )}

      <Pressable
        onPress={handleDelete}
        disabled={!isConfirmed || submitting}
        style={{
          padding: 14,
          backgroundColor: isConfirmed ? '#ff3b3b' : '#5a2227',
          borderRadius: 6,
          opacity: submitting ? 0.6 : 1,
          marginBottom: 12,
        }}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text
            style={{
              color: '#fff',
              textAlign: 'center',
              fontWeight: '700',
              fontSize: 15,
            }}
          >
            Permanently delete my account
          </Text>
        )}
      </Pressable>

      <Pressable
        onPress={() => router.back()}
        disabled={submitting}
        style={{
          padding: 14,
          borderWidth: 1,
          borderColor: '#2a3040',
          borderRadius: 6,
        }}
      >
        <Text
          style={{
            color: '#f3f4f8',
            textAlign: 'center',
            fontWeight: '500',
            fontSize: 15,
          }}
        >
          Cancel
        </Text>
      </Pressable>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}
