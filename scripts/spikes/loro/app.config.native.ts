import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Creative Cooking Loro Spike',
  slug: 'creative-cooking-loro-spike',
  version: '0.1.0',
  scheme: 'creative-cooking-loro-spike',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  plugins: ['expo-router'],
  experiments: { typedRoutes: true },
  ios: {
    bundleIdentifier: 'com.creativecooking.lorospike',
    config: { usesNonExemptEncryption: false }
  },
  android: {
    package: 'com.creativecooking.lorospike'
  }
};

export default config;
