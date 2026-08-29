import {
  ConfigContext,
  ExpoConfig,
} from 'expo/config';

/**
 * APP_VARIANT=production (set in EAS production profile) omits expo-dev-client
 * so store binaries do not ship the dev-client plugin.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const isProduction = process.env.APP_VARIANT === 'production';

  const plugins: ExpoConfig['plugins'] = [
    'expo-font',
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
    orientation: 'portrait',
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
    plugins,
    owner: 'orkunozekin',
  };
};
