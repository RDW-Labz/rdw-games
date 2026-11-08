// Presentational fields for the optional profile step (0448): phone +
// EXPLICIT SMS consent (a separate, unchecked checkbox — checking it is the
// only thing that ever sets sms_consent_at) + "how did you hear about us?".
// Used both by the one-time post-ZIP nudge (components/ZipGateHost.tsx) and
// by the always-available app/profile/edit.tsx section. Fully controlled —
// no network calls here.

import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import { colors } from '@auction-platform/design-system';
import { SMS_CONSENT_TEXT, HEARD_ABOUT_OPTIONS, HEARD_ABOUT_OTHER_MAX_LEN } from '@/lib/optional-profile';
import { SMS_CONSENT_ENABLED } from '@auction-platform/shared';

export function OptionalProfileFields({
  phone,
  onPhoneChange,
  showPhoneField = true,
  smsConsent,
  onSmsConsentChange,
  consentedAt,
  heardAbout,
  onHeardAboutChange,
  heardAboutOther,
  onHeardAboutOtherChange,
}: {
  phone: string;
  onPhoneChange: (v: string) => void;
  /** false on app/profile/edit.tsx, which already has its own phone field
   *  above this section — avoids showing phone twice. */
  showPhoneField?: boolean;
  smsConsent: boolean;
  onSmsConsentChange: (v: boolean) => void;
  /** When set (profile/edit.tsx, already consented), the consent is shown as
   *  a fixed record, not a re-toggleable switch — a timestamped consent is
   *  never silently revoked by an unrelated profile save. To stop texts,
   *  the bidder uses the existing SMS notification toggle; consent itself
   *  is a one-time legal record. Omitted in the nudge, where consent is
   *  always still unset. */
  consentedAt?: string | null;
  heardAbout: string | null;
  onHeardAboutChange: (v: string) => void;
  heardAboutOther: string;
  onHeardAboutOtherChange: (v: string) => void;
}) {
  return (
    <View>
      {/* Phone + text consent: held until the consent wording is approved. */}
      {SMS_CONSENT_ENABLED && showPhoneField && (
        <>
          <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase' }}>Phone</Text>
          <TextInput
            testID="optional-profile-phone"
            value={phone}
            onChangeText={onPhoneChange}
            placeholder="+1 (555) 555-5555"
            placeholderTextColor="#8a93a6"
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            style={{
              marginTop: 4,
              padding: 14,
              backgroundColor: '#1c2e49',
              borderColor: '#232839',
              borderWidth: 1,
              borderRadius: 6,
              color: '#e8eaf0',
              fontSize: 16,
            }}
            accessibilityLabel="Phone number"
          />
        </>
      )}

      {!SMS_CONSENT_ENABLED ? null : consentedAt ? (
        <View
          style={{
            marginTop: 14,
            padding: 12,
            borderColor: '#232839',
            borderWidth: 1,
            borderRadius: 6,
          }}
        >
          <Text style={{ color: '#34d39a', fontSize: 13, fontWeight: '700' }}>
            Texting consent recorded {new Date(consentedAt).toLocaleDateString()}
          </Text>
          <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 4 }}>
            To stop texts, turn off SMS under Notifications above.
          </Text>
        </View>
      ) : (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
            marginTop: 14,
            opacity: phone.trim() ? 1 : 0.5,
          }}
        >
          <Switch
            testID="optional-profile-sms-consent"
            value={smsConsent}
            onValueChange={onSmsConsentChange}
            disabled={!phone.trim()}
            trackColor={{ false: '#232839', true: '#4f8cff' }}
            thumbColor={smsConsent ? '#fff' : '#8a93a6'}
            accessibilityLabel="Agree to receive text messages"
          />
          <Text style={{ flex: 1, color: '#8a93a6', fontSize: 12, lineHeight: 17 }}>
            {SMS_CONSENT_TEXT}
          </Text>
        </View>
      )}

      <Text
        style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase', marginTop: 22 }}
      >
        How did you hear about us?
      </Text>
      <View style={{ marginTop: 6, gap: 6 }}>
        {HEARD_ABOUT_OPTIONS.map((opt) => {
          const selected = heardAbout === opt.value;
          return (
            <Pressable
              key={opt.value}
              testID={`heard-about-${opt.value}`}
              onPress={() => onHeardAboutChange(opt.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                padding: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: selected ? colors.primary : colors.border,
                backgroundColor: selected ? 'rgba(79,140,255,0.12)' : 'transparent',
              }}
            >
              <View
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  borderWidth: 2,
                  borderColor: selected ? colors.primary : '#8a93a6',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {selected && (
                  <View
                    style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }}
                  />
                )}
              </View>
              <Text style={{ color: colors.text, fontSize: 14 }}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {heardAbout === 'other' && (
        <TextInput
          testID="heard-about-other-text"
          value={heardAboutOther}
          onChangeText={(t) => onHeardAboutOtherChange(t.slice(0, HEARD_ABOUT_OTHER_MAX_LEN))}
          placeholder="Tell us more"
          placeholderTextColor="#8a93a6"
          maxLength={HEARD_ABOUT_OTHER_MAX_LEN}
          style={{
            marginTop: 8,
            padding: 12,
            backgroundColor: '#1c2e49',
            borderColor: '#232839',
            borderWidth: 1,
            borderRadius: 6,
            color: '#e8eaf0',
            fontSize: 14,
          }}
          accessibilityLabel="How you heard about us — other"
        />
      )}
    </View>
  );
}
