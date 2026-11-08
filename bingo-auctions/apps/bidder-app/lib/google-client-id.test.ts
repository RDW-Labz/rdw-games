// The Android sign-in crash of 2026-08-10 → 2026-09-24: an iOS client ID was
// handed to the Google provider on Android. These pin the platform split.

import { describe, it, expect } from 'vitest';
import { googleClientFor } from './google-client-id';

const IOS = '320714067980-e2dudrcgp50du1co0gdm91t1ie2rn70c.apps.googleusercontent.com';

describe('googleClientFor', () => {
  it('never gives Android the iOS client ID (the crash)', () => {
    expect(googleClientFor('android', { ios: IOS, android: undefined })).toBeNull();
  });

  it('uses the iOS client ID on iOS, under the iOS key', () => {
    expect(googleClientFor('ios', { ios: IOS, android: undefined })).toEqual({
      clientId: IOS,
      key: 'iosClientId',
    });
  });

  it('uses an Android client ID on Android, under the Android key, once one exists', () => {
    expect(googleClientFor('android', { ios: IOS, android: 'android-id' })).toEqual({
      clientId: 'android-id',
      key: 'androidClientId',
    });
  });

  it('hides the button when the platform has no ID, or is neither', () => {
    expect(googleClientFor('ios', { ios: undefined, android: 'android-id' })).toBeNull();
    expect(googleClientFor('ios', { ios: '', android: undefined })).toBeNull();
    expect(googleClientFor('web', { ios: IOS, android: 'android-id' })).toBeNull();
  });
});
