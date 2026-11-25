import { useEffect, useState, type PropsWithChildren } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { isThemePreference, type ThemePreference } from '@/domain/types';
import { resolveColorScheme, useSystemColorScheme } from '@/theme/theme';
import { palette, setActiveColorScheme } from '@/theme/StyleSheet';

// Setup runs before AppStateProvider exists, so it cannot use useAppTheme.
export function useSetupColors() {
  const system = useSystemColorScheme();
  const [preference] = useState<ThemePreference>(() => {
    try {
      const stored = Platform.OS === 'web' ? globalThis.localStorage?.getItem('creative-cooking-theme-v1') : null;
      return isThemePreference(stored) ? stored : 'system';
    } catch {
      return 'system';
    }
  });
  const scheme = resolveColorScheme(preference, system);
  const dark = scheme === 'dark';
  const colors = palette(scheme);
  // Panels shown during setup read the active scheme for their own colours.
  useEffect(() => setActiveColorScheme(scheme), [scheme]);
  return {
    dark,
    background: colors.background,
    surface: colors.surface,
    text: colors.text,
    muted: colors.muted,
    border: dark ? '#334155' : '#e2e8f0',
    primary: colors.primary,
    soft: dark ? '#10251a' : '#f0fdf4',
    accent: dark ? '#86efac' : '#166534',
    error: dark ? '#fecaca' : '#991b1b'
  };
}

export function SetupScreen({ children }: PropsWithChildren) {
  const colors = useSetupColors();
  return (
    <SafeAreaView style={[setupStyles.screen, { backgroundColor: colors.background }]}>
      <StatusBar style={colors.dark ? 'light' : 'dark'} />
      <ScrollView contentContainerStyle={setupStyles.scroll} keyboardShouldPersistTaps="handled">
        <View style={setupStyles.content}>{children}</View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** A bordered card for controls embedded in a setup screen, such as recovery. */
export function SetupPanel({ children }: PropsWithChildren) {
  const colors = useSetupColors();
  return <View style={[setupStyles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>;
}

export function SetupDisclosure({ title, preserveContent = false, children }: PropsWithChildren<{ title: string; preserveContent?: boolean }>) {
  const colors = useSetupColors();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return (
    <View style={{ gap: 12 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={title} aria-expanded={open} accessibilityState={{ expanded: open }}
        onPress={() => { setOpened(true); setOpen(value => !value); }} style={[setupStyles.disclosure, { borderColor: colors.border }]}>
        <Text style={[setupStyles.disclosureText, { color: colors.text }]}>{title}</Text>
        <Text aria-hidden style={{ color: colors.muted, fontSize: 20 }}>{open ? '−' : '+'}</Text>
      </Pressable>
      {open || (preserveContent && opened) ? <View accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'} style={{ gap: 12, display: open ? 'flex' : 'none' }}>{children}</View> : null}
    </View>
  );
}

export const setupStyles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingVertical: 32 },
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: 24 },
  eyebrow: { fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  title: { fontSize: 34, lineHeight: 40, fontWeight: '800' },
  subtitle: { fontSize: 18, lineHeight: 27 },
  body: { fontSize: 15, lineHeight: 23 },
  small: { fontSize: 13, lineHeight: 20 },
  card: { borderWidth: 1, borderRadius: 20, padding: 20, gap: 14 },
  cardTitle: { fontSize: 19, lineHeight: 26, fontWeight: '800' },
  button: { minHeight: 52, borderRadius: 16, paddingHorizontal: 20, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#ffffff', fontSize: 16, lineHeight: 23, fontWeight: '800', textAlign: 'center' },
  disabled: { opacity: 0.5 },
  disclosure: { minHeight: 48, borderTopWidth: 1, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  disclosureText: { flex: 1, fontSize: 15, lineHeight: 22, fontWeight: '700' },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15 },
  checkbox: { minHeight: 48, paddingVertical: 10, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }
});
