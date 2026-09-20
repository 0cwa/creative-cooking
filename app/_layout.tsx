import { useEffect } from 'react';
import { Alert } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppStateProvider } from '@/state/AppState';
import { finishOpenRouterOAuthFromLocation } from '@/llm/openrouter/oauth';
import { importSharedOpenRouterKey } from '@/llm/openrouter/share';
import { requestPersistentStorageOnce } from '@/storage/persistence';

function BootTasks() {
  useEffect(() => {
    void (async () => {
      try {
        const imported = await importSharedOpenRouterKey();
        if (imported) {
          Alert.alert(
            'Shared OpenRouter key connected',
            'This browser can now use the shared provider key. Anyone with the complete share link can use that key until it is revoked.'
          );
        }
      } catch (error) {
        Alert.alert('Could not import shared key', error instanceof Error ? error.message : 'Unknown error');
      }

      try {
        const connected = await finishOpenRouterOAuthFromLocation();
        if (connected) Alert.alert('OpenRouter connected', 'The Chef can now use your OpenRouter account.');
      } catch (error) {
        Alert.alert('OpenRouter sign-in failed', error instanceof Error ? error.message : 'Unknown error');
      }

      try {
        await requestPersistentStorageOnce();
      } catch {
        // Persistence is a best-effort browser capability; backup/restore remains available.
      }
    })();
  }, []);
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppStateProvider>
        <BootTasks />
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="settings" />
        </Stack>
      </AppStateProvider>
    </SafeAreaProvider>
  );
}
