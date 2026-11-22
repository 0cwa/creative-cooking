import { useEffect, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SetupDisclosure, SetupScreen, setupStyles as styles, useSetupColors } from './SetupScreen';

type KitchenStartupStatusProps = PropsWithChildren<{
  error?: string | null;
  onRetry?: () => void;
  loadingTitle?: string;
  loadingDetail?: string;
  errorTitle?: string;
  errorDetail?: string;
}>;

export function kitchenStartupErrorMessage(error: string) {
  if (/LOCK_UNAVAILABLE|Web Locks/i.test(error)) {
    return 'This browser is missing a feature needed to open your kitchen. Open the app in an updated browser using its https:// address, then try again.';
  }
  if (/quota|disk.*full|storage.*full/i.test(error)) {
    return 'There is not enough device storage to open your kitchen. Free some space, then try again.';
  }
  if (/SecurityError|access.*denied|permission.*denied|storage.*blocked|operation is insecure/i.test(error)) {
    return 'Your browser is blocking the storage Creative Cooking needs. Allow site storage or open the link in a regular browser window, then try again.';
  }
  if (/WebAssembly|wasm|Failed to fetch|Loading.*chunk|dynamically imported module/i.test(error)) {
    return 'A part of the app could not load. Check your connection, then try opening your kitchen again.';
  }
  if (/MISSING_BOOTSTRAP|^LOCKED$|INVALID_PROOF|INVALID_AUTHORITY/i.test(error)) {
    return 'The saved kitchen could not be verified on this device. Try again, or use your recovery options if you have a saved archive.';
  }
  if (/branch changed before it could reopen|Workspace choice changed while opening/i.test(error)) {
    return error;
  }
  return 'Creative Cooking could not read your kitchen from device storage. Try opening it again.';
}

/** Shared by workspace bootstrap and the first content read. It never resets data. */
export function KitchenStartupStatus({
  error = null,
  onRetry,
  loadingTitle = 'Opening your kitchen…',
  loadingDetail = 'Loading your saved kitchen on this device.',
  errorTitle = 'Could not open your kitchen',
  errorDetail = 'Your existing kitchen and saved data stay on this device while you retry.',
  children
}: KitchenStartupStatusProps) {
  const colors = useSetupColors();
  const failed = error !== null;
  const [takingLonger, setTakingLonger] = useState(false);

  useEffect(() => {
    setTakingLonger(false);
    if (failed) return;
    // This changes the explanation only. Retrying remains a deliberate action;
    // bootstrap and content reads must never be started again by a timer.
    const timer = setTimeout(() => setTakingLonger(true), 12_000);
    return () => clearTimeout(timer);
  }, [failed, loadingTitle, loadingDetail]);

  return <SetupScreen>
    <View style={{ gap: 12 }}>
      <Text style={[styles.eyebrow, { color: colors.accent }]}>CREATIVE COOKING</Text>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
        {failed ? errorTitle : loadingTitle}
      </Text>
    </View>

    {failed ? <View accessibilityRole="alert" style={{ gap: 14 }}>
      <Text style={[styles.body, { color: colors.text }]}>{kitchenStartupErrorMessage(error)}</Text>
      <Text style={[styles.small, { color: colors.muted }]}>{errorDetail}</Text>
    </View> : <View accessibilityLiveRegion="polite" style={{ gap: 16 }}>
      <ActivityIndicator accessibilityLabel={loadingTitle} color={colors.accent} size="large" style={{ alignSelf: 'flex-start' }} />
      <Text style={[styles.body, { color: colors.muted }]}>{loadingDetail}</Text>
      {takingLonger ? <Text style={[styles.small, { color: colors.muted }]}>
        {onRetry
          ? 'This is taking longer than usual. You can keep waiting or try opening the same kitchen again. Your saved data stays on this device.'
          : 'This is taking longer than usual. Keep this page open while your kitchen finishes loading. Your saved data stays on this device.'}
      </Text> : null}
    </View>}

    {(failed || takingLonger) && onRetry ? <Pressable accessibilityRole="button" onPress={onRetry}
      style={[styles.button, { backgroundColor: colors.primary }]}>
      <Text style={styles.buttonText}>Try again</Text>
    </Pressable> : null}

    {failed ? <SetupDisclosure title="Show technical details">
      <Text selectable style={[styles.small, { color: colors.muted }]}>{error}</Text>
    </SetupDisclosure> : null}
    {children}
  </SetupScreen>;
}
