import type { ExpoConfig } from 'expo/config';

const baseUrl = process.env.EXPO_PUBLIC_BASE_URL ?? '';

const config: ExpoConfig = {
  name: 'Creative Cooking',
  slug: 'creative-cooking',
  version: '0.1.0',
  scheme: 'creative-cooking',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  githubUrl: 'https://github.com/0cwa/creative-cooking',
  web: {
    output: 'static',
    name: 'Creative Cooking',
    shortName: 'Cook',
    favicon: './assets/icon-192.png'
  },
  plugins: ['expo-router', 'expo-secure-store'],
  experiments: {
    typedRoutes: true,
    baseUrl
  },
  ios: {
    config: { usesNonExemptEncryption: false }
  }
};

export default config;
