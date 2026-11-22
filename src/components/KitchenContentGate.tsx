import { useContext, useRef, type PropsWithChildren } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useAppState } from '@/state/AppState';
import { RecoveryStart } from '@/loro/app/RecoveryStart';
import { LoroWorkspaceValue } from '@/loro/app/WorkspaceStatus';
import { KitchenStartupStatus } from './KitchenStartupStatus';
import { SetupDisclosure, setupStyles as styles, useSetupColors } from './SetupScreen';

/** Keep navigation and boot tasks unmounted until real saved content is ready. */
export function KitchenContentGate({ children }: PropsWithChildren) {
  const { hydrated, storageError, retryStorage } = useAppState();
  const workspace = useContext(LoroWorkspaceValue);
  const colors = useSetupColors();
  const retrying = useRef(false);
  const failed = storageError !== null;

  if (hydrated) return children;

  const retry = async () => {
    if (retrying.current) return;
    retrying.current = true;
    try {
      await retryStorage();
    } finally {
      retrying.current = false;
    }
  };

  return <KitchenStartupStatus
    error={storageError}
    errorTitle="Your kitchen could not finish opening"
    loadingDetail="Loading your pantry, recipes, and preferences from this device."
    onRetry={failed ? () => void retry() : undefined}
  >
    {failed && typeof workspace?.reopen === 'function' ? <Pressable accessibilityRole="button" onPress={() => workspace.reopen()}
      style={[styles.button, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}>
      <Text style={[styles.buttonText, { color: colors.text }]}>Open kitchen again</Text>
    </Pressable> : null}
    {failed && Platform.OS === 'web' ? <SetupDisclosure title="Recover an existing kitchen" preserveContent>
      <View style={{ backgroundColor: '#ffffff', padding: 16, borderRadius: 16 }}><RecoveryStart /></View>
    </SetupDisclosure> : null}
  </KitchenStartupStatus>;
}
