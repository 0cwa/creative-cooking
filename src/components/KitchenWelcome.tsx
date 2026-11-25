import { Platform, Pressable, Text, View } from 'react-native';
import { RecoveryStart } from '@/loro/app/RecoveryStart';
import { SetupDisclosure, SetupPanel, SetupScreen, setupStyles as styles, useSetupColors } from './SetupScreen';
import { kitchenStartupErrorMessage } from './KitchenStartupStatus';

/** The only setup screen. Pressing Start is the explicit acceptance of the on-device privacy policy. */
export function KitchenWelcome({ onStart, error, resuming = false }: {
  onStart: () => void;
  error: string | null;
  resuming?: boolean;
}) {
  const colors = useSetupColors();
  const supported = Platform.OS === 'web' || Platform.OS === 'android';
  return (
    <SetupScreen>
      <View style={{ gap: 12 }}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Welcome to Creative Cooking</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>A few ingredients. A fresh idea for dinner.</Text>
      </View>

      <View style={{ gap: 10 }}>
        {supported ? <Pressable accessibilityRole="button" onPress={onStart} style={[styles.button, { backgroundColor: colors.primary }]}>
          <Text style={styles.buttonText}>Start cooking</Text>
        </Pressable> : <Text style={[styles.body, { color: colors.muted }]}>Kitchen setup is currently available in a web browser or the Android app.</Text>}
        <Text testID="privacy-summary" style={[styles.small, { color: colors.muted }]}>{resuming
          ? 'Your kitchen is already here. Start to finish opening it; no new kitchen is created.'
          : 'Everything stays on this device. No account needed.'} Starting accepts on-device-only processing.{Platform.OS === 'web' ? ' You can change this later in Settings.' : ''}</Text>
        {error ? <>
          <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>{kitchenStartupErrorMessage(error)}</Text>
          <SetupDisclosure title="Show technical details"><Text selectable style={[styles.small, { color: colors.muted }]}>{error}</Text></SetupDisclosure>
        </> : null}
      </View>

      {Platform.OS === 'web' ? <SetupDisclosure title="Recover an existing kitchen" preserveContent>
        <Text style={[styles.body, { color: colors.muted }]}>Have an encrypted personal archive or a guardian recovery request? Open the recovery controls below.</Text>
        <SetupPanel><RecoveryStart /></SetupPanel>
      </SetupDisclosure> : null}
    </SetupScreen>
  );
}
