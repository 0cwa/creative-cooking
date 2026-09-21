import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppStateProvider, useAppState } from '@/state/AppState';
import { FirstOpenLoadingAnimation } from '@/components/FirstOpenLoadingAnimation';
import { finishOpenRouterOAuthFromLocation } from '@/llm/openrouter/oauth';
import { importSharedOpenRouterKey } from '@/llm/openrouter/share';
import { requestPersistentStorageOnce } from '@/storage/persistence';

function StorageFailureAlert() {
  const { storageError } = useAppState();
  const shownError = useRef<string | null>(null);

  useEffect(() => {
    if (!storageError) {
      shownError.current = null;
      return;
    }
    if (shownError.current === storageError) return;
    shownError.current = storageError;
    Alert.alert(
      'Local data is not being saved',
      `${storageError}\n\nYour current changes remain open in this session. Open Settings → Data & Storage to retry or export a backup.`
    );
  }, [storageError]);

  return null;
}

function BootTasks() {
  const app = useAppState();

  useEffect(() => {
    void (async () => {
      try {
        const imported = await importSharedOpenRouterKey();
        if (imported) {
          app.updateSettings({ providerId: 'openrouter', model: 'openrouter/free' });
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
        if (connected) {
          app.updateSettings({ providerId: 'openrouter', model: 'openrouter/free' });
          Alert.alert('OpenRouter connected', 'The Chef can now use your OpenRouter account.');
        }
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
        <StorageFailureAlert />
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="settings" />
        </Stack>
        <FirstOpenLoadingAnimation />
      </AppStateProvider>
    </SafeAreaProvider>
  );
}
