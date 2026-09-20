import { useEffect } from 'react';
import { Alert } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppStateProvider } from '@/state/AppState';
import { finishOpenRouterOAuthFromLocation } from '@/llm/openrouter/oauth';

function OAuthFinisher() {
  useEffect(() => {
    finishOpenRouterOAuthFromLocation()
      .then((connected) => {
        if (connected) Alert.alert('OpenRouter connected', 'The Chef can now use your OpenRouter account.');
      })
      .catch((error: unknown) => Alert.alert('OpenRouter sign-in failed', error instanceof Error ? error.message : 'Unknown error'));
  }, []);
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppStateProvider>
        <OAuthFinisher />
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="settings" />
        </Stack>
      </AppStateProvider>
    </SafeAreaProvider>
  );
}
