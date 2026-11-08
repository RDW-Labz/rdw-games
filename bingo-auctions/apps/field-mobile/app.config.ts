// app.config.ts — dynamic Expo config (replaces app.json).
//
// WHY .ts INSTEAD OF .json:
// During a bad EAS Update OTA rollout we hit a death-loop on launch; the
// `updates.disableAntiBrickingMeasures` flag keeps the OS-level rollback path
// alive so the user can escape the loop. That flag must be TRUE for
// development/preview builds and FALSE for App Store production builds (Apple
// reviewers reject apps that appear to self-modify). A static app.json cannot
// express that distinction; a dynamic config file reads EAS_BUILD_PROFILE
// (auto-set by EAS Build) and flips the flag per profile.
//
// LAUNCH_PLAN §1.6

import { ExpoConfig } from 'expo/config';

const isProduction = process.env.EAS_BUILD_PROFILE === 'production';
// Tester build installs NEXT TO the floor app (own ID, own name), never over it.
const isTester = process.env.EAS_BUILD_PROFILE === 'tester';

const config: ExpoConfig = {
  name: isTester ? 'BinGo Staff TEST' : 'BinGo Staff',
  slug: 'bingo-field',
  // 2026-08-11: 0.1.0 -> 1.0.1. Two builds were uploaded as version "1.0" —
  // build 20 (Jul 20) and build 27 (Aug 3) — while every other build in the
  // train is 0.1.0. iOS compares CFBundleShortVersionString BEFORE the build
  // number, and 1.0 > 0.1.0, so once a phone took build 27 every later build
  // read as a DOWNGRADE and TestFlight stopped offering updates. Jared's phone
  // sat on build 27 from Aug 3 through Aug 11 while builds 28-31 shipped past
  // it, which is why the staff iPhones had no relot scanner.
  //
  // runtimeVersion policy is 'appVersion', so that same phone was also pinned
  // to OTA runtime "1.0" while every OTA published to "0.1.0" — it could not
  // receive JS updates either. Going to 1.0.1 clears both: it outranks the
  // stray 1.0 builds, and new OTAs target runtime 1.0.1 alongside the binary.
  //
  // The version must stay ABOVE 1.0 from here on. Same class of mistake as the
  // bidder app's 0.1.1-vs-released-1.0.0 rejections (see its app.config.ts).
  // That rule is now enforced, not just written down: eas-build.yml runs
  // scripts/store-release/version_guard.py against App Store Connect before
  // every iOS build, and app-version-guard.yml re-checks it on any PR that
  // touches this file.
  version: '1.0.1',
  orientation: 'portrait',
  scheme: isTester ? 'bingostafftest' : 'bingostaff',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  platforms: ['ios', 'android'],
  icon: './assets/icon.png',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#15233a',
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: isTester ? 'com.bingoauctions.staff.test' : 'com.bingoauctions.staff',
    // 2026-05-28a: NSPhotoLibrary* purpose strings added to resolve ITMS-90683 from build #49 submission.
    // 2026-05-28b: NSLocationWhenInUseUsageDescription added to resolve a SECOND
    //   ITMS-90683 emitted on build #53. Apple's static analyzer flags any
    //   binary that imports ARKit because the framework transitively references
    //   CoreLocation symbols (used by ARGeoTrackingConfiguration). Our
    //   modules/clovrbid-arkit/ uses ARWorldTrackingConfiguration and never
    //   actually calls location APIs at runtime — but the purpose string must
    //   still be present or Apple's reviewer will reject. The string below is
    //   what an end user would see IF iOS ever prompted them (in practice they
    //   won't, because we never request location authorization).
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSPhotoLibraryAddUsageDescription:
        'BinGo Staff saves lot photos and warehouse references back to your photo library when you choose to export them.',
      NSLocationWhenInUseUsageDescription:
        'BinGo Staff uses augmented-reality positioning (ARKit) during walk-and-scan to map lots to warehouse bins. Your device location is not transmitted off the device.',
    },
    // Apple privacy manifest (required-reason APIs). Belt-and-suspenders entry
    // for UserDefaults via @react-native-async-storage/async-storage — the one
    // category Apple's static-pod parser sometimes fails to read from the
    // library-shipped .xcprivacy, which triggers a post-submission email (not a
    // hard rejection). CA92.1 = "access info only from the app itself / app
    // group." FileTimestamp/DiskSpace/BootTime are already covered by the
    // RN/expo library manifests. Takes effect at the next native build.
    privacyManifests: {
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
        },
      ],
    },
  },
  android: {
    package: isTester ? 'com.bingoauctions.staff.test' : 'com.bingoauctions.staff',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#15233a',
    },
    softwareKeyboardLayoutMode: 'resize',
    // 2026-05-28: dropped 'android.permission.RECORD_AUDIO' — react-native-
    // vision-camera plugin already has enableMicrophonePermission: false
    // above, and no other code path captures audio. Removing avoids Play
    // Console "unused dangerous permission" flags.
    permissions: [
      'android.permission.CAMERA',
    ],
  },
  plugins: [
    'expo-router',
    // Brand fonts (Plus Jakarta Sans) embedded at build time, registered
    // natively at startup (no runtime useFonts gate). Matches the web display
    // font; consumed via fontFamily in @auction-platform/design-system.
    [
      'expo-font',
      {
        fonts: [
          './assets/fonts/PlusJakartaSans_600SemiBold.ttf',
          './assets/fonts/PlusJakartaSans_700Bold.ttf',
          './assets/fonts/PlusJakartaSans_800ExtraBold.ttf',
        ],
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Pick a floor plan or warehouse photo from your library.',
      },
    ],
    [
      'react-native-vision-camera',
      {
        cameraPermissionText:
          'BinGo Staff needs the camera to scan barcodes on bins and lots and photograph items for AI identification.',
        enableMicrophonePermission: false,
        enableCodeScanner: true,
      },
    ],
    // 2026-05-20: @sentry/react-native plugin removed. Matches the bidder
    // app's fix. Sentry's iOS CPPExceptionTerminate handler was intercepting
    // the real RNSScreen iOS 26 crash and masking its stack trace across
    // 22 TestFlight reports. Sentry must not auto-init via AppDelegate in
    // production builds on iOS 26.x until upstream addresses the issue.
    'expo-web-browser',
    // 2026-05-21: Local Expo module (modules/clovrbid-arkit) for minimal
    // ARKit camera-pose tracking inside the walk-and-scan flow. The
    // plugin only adds `arkit` to UIRequiredDeviceCapabilities — the
    // native module itself is auto-discovered by expo-modules-core at
    // prebuild time. Falls back gracefully when AR is unavailable.
    './plugins/clovrbid-arkit',
    // 2026-05-21: bump iOS deployment target to 16.0. The ClovrbidArkit
    // podspec requires iOS 16 (ARWorldTrackingConfiguration semantics
    // tightened in 16; older targets pull a less-stable code path).
    // Without this, EAS build fails with
    // EAS_BUILD_HIGHER_MINIMUM_DEPLOYMENT_TARGET_ERROR because
    // expo-modules-core's default is 13.4.
    [
      'expo-build-properties',
      {
        ios: {
          deploymentTarget: '16.0',
        },
      },
    ],
    // 2026-05-21 — DISABLED. Re-enable AFTER running `npx eas credentials
    // --platform ios` interactively ONCE to populate the credential cache
    // for the share-extension target (`com.bingoauctions.staff.share-extension`).
    //
    // Confirmed via EAS-CLI source (credentials/context.js → bestEffortAppStoreAuthenticateAsync):
    // the non-interactive code path explicitly returns BEFORE attempting Apple auth, so no
    // env-var combination (EXPO_ASC_KEY_ID / EXPO_ASC_ISSUER_ID / EXPO_ASC_API_KEY_PATH) can
    // bypass the missing-cached-creds gate on a target's first build.
    //
    // One-time setup (run from any real PowerShell / terminal):
    //   cd C:\Users\jmacl\Projects\auction-platform\apps\field-mobile
    //   npx eas credentials --platform ios
    //   # Pick: profile = preview
    //   # Pick: target  = BinGo Staff (com.bingoauctions.staff.share-extension)
    //   # Set up new provisioning profile, reuse existing distribution cert
    //
    // Then uncomment the block below, commit, push, and run a fresh EAS
    // build — non-interactive will work because the provisioning profile
    // is now cached on Expo's servers (and the bundle ID is already
    // registered with Apple via ASC API).
    //
    // [
    //   'expo-share-intent',
    //   {
    //     iosActivationRules: {
    //       NSExtensionActivationSupportsWebURLWithMaxCount: 1,
    //       NSExtensionActivationSupportsWebPageWithMaxCount: 0,
    //       NSExtensionActivationSupportsImageWithMaxCount: 0,
    //       NSExtensionActivationSupportsMovieWithMaxCount: 0,
    //       NSExtensionActivationSupportsText: false,
    //       NSExtensionActivationSupportsFileWithMaxCount: 0,
    //     },
    //     iosShareExtensionName: 'BinGo Staff',
    //     androidIntentFilters: [],
    //   },
    // ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    eas: {
      projectId: '57a90d99-3250-4498-b5ff-5cb4dcb79742',
    },
    router: {},
  },
  owner: 'rdw_cluer',
  // 2026-08-14 — LEGACY-DEVICE OTA ESCAPE HATCH.
  //
  // The Aug-11 0.1.0 -> 1.0.1 version bump (#248) orphaned every Android APK
  // already on the warehouse floor. Policy is 'appVersion', so those phones run
  // runtime "0.1.0" while every update published since is stamped "1.0.1", and
  // a client only accepts an exact runtime match. Three OTAs published today
  // succeeded and were invisible to them — no error, on either side.
  //
  // OTA_RUNTIME_VERSION lets ONE `eas update` declare an older runtime so those
  // stranded devices can take a fix, WITHOUT touching `version` (still 1.0.1).
  // The store label, the build train and the #249 version guard are all
  // unaffected — this only changes what an update says it is FOR.
  //
  // It is publish-only by construction: EAS Build sets EAS_BUILD=true, and this
  // throws there. A binary can never be produced with an overridden runtime,
  // which is the failure that would strand devices permanently rather than
  // rescue them.
  //
  // This is a STOPGAP. Phones rescued this way stay on 0.1.0, so every future
  // update must be published twice until they get a 1.0.1 binary. Install the
  // internal APK and this can be deleted.
  runtimeVersion: (() => {
    const override = process.env.OTA_RUNTIME_VERSION?.trim();
    if (!override) return { policy: 'appVersion' as const };
    if (process.env.EAS_BUILD === 'true') {
      throw new Error(
        'OTA_RUNTIME_VERSION must never be set during a build — it is for ' +
          '`eas update` only. A binary built with an overridden runtime would ' +
          'strand the device instead of rescuing it.',
      );
    }
    return override;
  })(),
  // 2026-05-25: OTA RESTORED. The 2026-05-20 removal was a defensive hedge
  // during iOS 26 launch-crash debugging. The actual root cause (per memory
  // auction_platform_ios26_launch_crash.md) was react-native-screens 4.16 +
  // Sentry CPPExceptionTerminate masking — NOT expo-updates. RNS is now on
  // 4.18 and Sentry is fully removed (verify: grep '"react-native-screens"'
  // in this package.json + no @sentry/* deps anywhere). Bidder-app runs
  // the same expo-updates ~29.0.17 pin with no issues, so re-enabling on
  // staff after a fresh EAS Build carrying the runtime should be safe.
  //
  // `disableAntiBrickingMeasures: false` keeps OS-level recovery enabled
  // — if a broken OTA lands, the Launcher falls back to the embedded JS
  // bundle silently instead of crashing. The opposite setting (TRUE) was
  // what caused the v16/20/21/22 death-loop on bidder before 2026-05-19;
  // never flip it back to TRUE in either profile.
  updates: {
    url: 'https://u.expo.dev/57a90d99-3250-4498-b5ff-5cb4dcb79742',
    fallbackToCacheTimeout: 0,
    checkAutomatically: 'ON_LOAD',
    useEmbeddedUpdate: true,
    disableAntiBrickingMeasures: false,
  },
};

// _appleSignIn_TODO is a documentation-only string field preserved from the original app.json ios
// block. It is not part of the IOS type but Expo CLI passes unknown nested fields through without
// error. Kept as a documentation artifact so it is visible in `expo config --json` output.
// @ts-expect-error _appleSignIn_TODO is an undocumented pass-through field, not in IOS typings.
config.ios!._appleSignIn_TODO =
  "Set `usesAppleSignIn: true` ONLY after enabling 'Sign in with Apple' capability on com.bingoauctions.staff in Apple Developer Portal (Certificates, Identifiers & Profiles → Identifiers → bundle → Capabilities). EAS Build will then auto-update the provisioning profile to include com.apple.developer.applesignin. Until then, leaving this off so EAS Build can sign the IPA. The OAuthButtons component also hides the Apple Sign-In button via SHOW_APPLE_SIGNIN=false. Flip both together.";

export default config;
