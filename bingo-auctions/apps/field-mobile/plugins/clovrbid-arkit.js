// Expo config plugin for the local ClovrbidArkit native module.
//
// What it does:
//   1. Adds `arkit` to UIRequiredDeviceCapabilities — App Store Connect
//      uses this to filter the app to ARKit-capable devices only. The
//      staff app already targets iOS 16+, which covers iPhone X+ and all
//      ARKit-capable iPads.
//
// What it does NOT do:
//   - NSCameraUsageDescription: already set by react-native-vision-camera
//     plugin in app.config.ts. ARKit reuses the same camera permission;
//     no duplication needed.
//   - Provisioning entitlements: none required for plain ARKit use.
//     The framework is part of the iOS system and doesn't need explicit
//     entitlements (in contrast to e.g. CallKit, HealthKit, etc).
//   - Podfile manipulation: the local module is discovered by
//     `expo-modules-core` at prebuild time via the
//     `modules/clovrbid-arkit/expo-module.config.json` discovery file.
//     EAS Build runs prebuild in the cloud and picks it up automatically.

const { withInfoPlist } = require('@expo/config-plugins');

function withClovrbidArkit(config) {
  return withInfoPlist(config, (c) => {
    const plist = c.modResults;

    const caps = Array.isArray(plist.UIRequiredDeviceCapabilities)
      ? plist.UIRequiredDeviceCapabilities
      : [];
    if (!caps.includes('arkit')) caps.push('arkit');
    plist.UIRequiredDeviceCapabilities = caps;

    return c;
  });
}

module.exports = withClovrbidArkit;
