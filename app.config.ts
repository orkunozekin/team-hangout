import {
  ConfigContext,
  ExpoConfig,
} from 'expo/config';

/**
 * APP_VARIANT=production (set in EAS production profile) omits expo-dev-client
 * so store binaries do not ship the dev-client plugin.
 */
const collectedForAppFunctionality = (type: string) => ({
  NSPrivacyCollectedDataType: type,
  NSPrivacyCollectedDataTypeLinked: true,
  NSPrivacyCollectedDataTypeTracking: false,
  NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
});

export default ({ config }: ConfigContext): ExpoConfig => {
  const isProduction = process.env.APP_VARIANT === 'production';

  const plugins: ExpoConfig['plugins'] = [
    'expo-font',
    ['expo-notifications', {
      color: '#0F3D2E',
      defaultChannel: 'team-updates',
      enableRemoteNotifications: true,
      enableBackgroundRemoteNotifications: false,
    }],
    ['expo-location', {
      locationWhenInUsePermission: 'Use your location once to assist with participant check-in. Location is optional and does not prove presence.',
      locationAlwaysPermission: false,
      locationAlwaysAndWhenInUsePermission: false,
      isIosBackgroundLocationEnabled: false,
      isAndroidBackgroundLocationEnabled: false,
      isAndroidForegroundServiceEnabled: false,
    }],
    'expo-apple-authentication',
    '@react-native-google-signin/google-signin',
  ];

  if (!isProduction) {
    plugins.splice(1, 0, 'expo-dev-client');
  }

  return {
    ...config,
    name: 'Team Hangout',
    slug: 'team-hangout',
    version: '1.0.0',
    scheme: 'teamhangout',
    orientation: !isProduction && process.env.EXPO_PUBLIC_PHASE3_SURFACE_HARNESS === 'true'
      ? 'default'
      : 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#0F3D2E',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.orkunozekin.teamhangout',
      googleServicesFile: './GoogleService-Info.plist',
      usesAppleSignIn: true,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
      },
      entitlements: {
        'aps-environment': isProduction ? 'production' : 'development',
      },
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
        NSPrivacyCollectedDataTypes: [
          collectedForAppFunctionality('NSPrivacyCollectedDataTypeEmailAddress'),
          collectedForAppFunctionality('NSPrivacyCollectedDataTypeName'),
          collectedForAppFunctionality('NSPrivacyCollectedDataTypeUserID'),
          collectedForAppFunctionality('NSPrivacyCollectedDataTypePhoneNumber'),
          collectedForAppFunctionality('NSPrivacyCollectedDataTypePhotosorVideos'),
          collectedForAppFunctionality('NSPrivacyCollectedDataTypePreciseLocation'),
          collectedForAppFunctionality('NSPrivacyCollectedDataTypeDeviceID'),
          collectedForAppFunctionality('NSPrivacyCollectedDataTypeOtherUserContent'),
        ],
        // Firebase Auth persistence (AsyncStorage) and Expo/React Native core.
        NSPrivacyAccessedAPITypes: [
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
          { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'] },
        ],
      },
    },
    android: {
      adaptiveIcon: {
        backgroundColor: '#0F3D2E',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      package: 'com.orkunozekin.teamhangout',
      googleServicesFile: './google-services.json',
    },
    web: {
      favicon: './assets/favicon.png',
    },
    extra: process.env.EXPO_PUBLIC_EAS_PROJECT_ID
      ? { eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID } }
      : config.extra,
    plugins,
    owner: 'orkunozekin',
  };
};
