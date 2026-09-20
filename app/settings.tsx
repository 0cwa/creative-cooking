import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { beginOpenRouterOAuth } from '@/llm/openrouter/oauth';
import { createOpenRouterShareLink } from '@/llm/openrouter/share';
import { freshDefaultState, parseBackup, serializeBackup } from '@/storage/backup';
import { clearOpenRouterKey, getOpenRouterKey, setOpenRouterKey } from '@/storage/credentialVault';
import { getPersistenceInfo, requestPersistentStorage, type PersistenceInfo } from '@/storage/persistence';
import { useAppState } from '@/state/AppState';

function formatBytes(value?: number): string {
  if (!value || value < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export default function SettingsScreen() {
  const router = useRouter();
  const app = useAppState();
  const [allergyInput, setAllergyInput] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [persistence, setPersistence] = useState<PersistenceInfo | null>(null);

  useEffect(() => {
    void getOpenRouterKey().then((value) => setHasKey(Boolean(value)));
    void getPersistenceInfo().then(setPersistence);
  }, []);

  const snapshot = () => ({
    pantry: app.pantry,
    recipes: app.recipes,
    chatMessages: app.chatMessages,
    mealContext: app.mealContext,
    settings: app.settings
  });

  const addAllergies = () => {
    const additions = allergyInput.split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);
    if (!additions.length) return;
    const merged = [...app.settings.allergies, ...additions].filter(
      (value, index, all) => all.findIndex((x) => x.toLocaleLowerCase() === value.toLocaleLowerCase()) === index
    );
    app.updateSettings({ allergies: merged });
    setAllergyInput('');
  };

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    await setOpenRouterKey(apiKey.trim());
    setApiKey('');
    setHasKey(true);
    Alert.alert('API key saved', Platform.OS === 'web' ? 'Stored only in this browser.' : 'Stored in the device secure store.');
  };

  const makeShareLink = async () => {
    try {
      const key = await getOpenRouterKey();
      if (!key) throw new Error('Connect an OpenRouter key first.');
      const link = await createOpenRouterShareLink(key);
      setShareLink(link);
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        Alert.alert('Share link copied', 'Send it only to someone you trust. The complete link grants use of this OpenRouter key.');
      }
    } catch (error) {
      Alert.alert('Could not create share link', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const copyShareLink = async () => {
    if (!shareLink || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(shareLink);
    Alert.alert('Copied', 'Share link copied to the clipboard.');
  };

  const requestDurableStorage = async () => {
    try {
      const info = await requestPersistentStorage();
      setPersistence(info);
      Alert.alert(
        info.persistent ? 'Durable storage enabled' : 'Browser kept best-effort storage',
        info.persistent
          ? 'Creative Cooking data should only be removed when you explicitly clear site data.'
          : 'This browser did not grant durable storage. Exported backups are still available.'
      );
    } catch (error) {
      Alert.alert('Storage request failed', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const exportData = () => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      Alert.alert('Web/PWA only for now', 'File backup export is currently implemented for the web/PWA build.');
      return;
    }
    const json = serializeBackup(snapshot());
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `creative-cooking-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const importData = () => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      Alert.alert('Web/PWA only for now', 'File backup restore is currently implemented for the web/PWA build.');
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      void (async () => {
        try {
          const file = input.files?.[0];
          if (!file) return;
          const restored = parseBackup(await file.text());
          app.restoreState(restored);
          Alert.alert('Backup restored', 'Pantry, recipes, chats, meal context, and settings were restored. Provider API keys are never included in backups.');
        } catch (error) {
          Alert.alert('Could not restore backup', error instanceof Error ? error.message : 'Unknown error');
        }
      })();
    };
    input.click();
  };

  const resetData = () => {
    Alert.alert(
      'Reset Creative Cooking data?',
      'This clears pantry, recipes, chats, and settings on this device. Your OpenRouter key stays connected.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => app.restoreState(freshDefaultState()) }
      ]
    );
  };

  const persistenceLabel = Platform.OS !== 'web'
    ? 'Device managed'
    : persistence?.persistent
      ? 'Durable'
      : persistence?.supported
        ? 'Best effort'
        : 'Browser managed';

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <View style={styles.backGlyph}>
            <View style={styles.backShaft} />
            <View style={styles.backHeadTop} />
            <View style={styles.backHeadBottom} />
          </View>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 42 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Section title="Allergies" subtitle="These are hard constraints and are sent with meal requests.">
          <View style={styles.inline}>
            <TextInput accessibilityLabel="Add allergies" value={allergyInput} onChangeText={setAllergyInput} onSubmitEditing={addAllergies} placeholder="e.g. peanuts, shellfish" placeholderTextColor="#94a3b8" style={styles.input} />
            <Pressable accessibilityRole="button" accessibilityLabel="Add allergies" onPress={addAllergies} style={styles.smallButton}><Text style={styles.smallButtonText}>Add</Text></Pressable>
          </View>
          <View style={styles.tags}>
            {app.settings.allergies.map((allergy) => (
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove allergy ${allergy}`} key={allergy} onPress={() => app.updateSettings({ allergies: app.settings.allergies.filter((x) => x !== allergy) })} style={styles.tag}>
                <Text style={styles.tagText}>{allergy} ×</Text>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section title="Context" subtitle="Optional context for meal timing and seasonal/regional suggestions.">
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Send local time & time zone</Text>
              <Text style={styles.help}>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown zone'}</Text>
            </View>
            <Switch accessibilityLabel="Send local time and time zone" value={app.settings.sendLocalTime} onValueChange={(sendLocalTime) => app.updateSettings({ sendLocalTime })} />
          </View>
          <Text style={styles.label}>City</Text>
          <TextInput accessibilityLabel="City" value={app.settings.city} onChangeText={(city) => app.updateSettings({ city })} placeholder="e.g. Stockholm" placeholderTextColor="#94a3b8" style={styles.input} />
          <Text style={styles.help}>City is enough; the app does not need precise GPS location.</Text>
        </Section>

        <Section title="Data & Storage" subtitle="Keep local state durable and make portable backups. API keys are intentionally excluded from backups.">
          <View style={styles.statusRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Browser storage</Text>
              {Platform.OS === 'web' && persistence && (
                <Text style={styles.help}>{formatBytes(persistence.usage)} used · {formatBytes(persistence.quota)} quota</Text>
              )}
            </View>
            <Text style={[styles.status, persistence?.persistent && styles.statusConnected]}>{persistenceLabel}</Text>
          </View>
          {Platform.OS === 'web' && persistence?.supported && !persistence.persistent && (
            <Pressable accessibilityRole="button" onPress={() => void requestDurableStorage()} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Request durable storage</Text>
            </Pressable>
          )}
          <Text style={styles.help}>
            Browsers may approve or deny durable storage silently. The app also requests it once automatically; backups remain the safest portable copy.
          </Text>
          <View style={styles.buttonRow}>
            <Pressable accessibilityRole="button" onPress={exportData} style={styles.smallButton}><Text style={styles.smallButtonText}>Export backup</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={importData} style={styles.smallButton}><Text style={styles.smallButtonText}>Restore backup</Text></Pressable>
          </View>
          <Pressable accessibilityRole="button" onPress={resetData} style={styles.textButton}><Text style={styles.dangerLink}>Reset cooking data on this device</Text></Pressable>
        </Section>

        <Section title="Master instructions" subtitle="Customize Chef’s style and priorities. Tool behavior, safety constraints, and app mechanics are managed separately and cannot be edited here.">
          <TextInput accessibilityLabel="Master instructions" value={app.settings.systemPrompt} onChangeText={(systemPrompt) => app.updateSettings({ systemPrompt })} multiline style={[styles.input, styles.prompt]} textAlignVertical="top" />
        </Section>

        <Section title="Chef provider" subtitle="OpenRouter gives the app one login/API surface across many model providers.">
          <View style={styles.statusRow}>
            <Text style={styles.label}>Connection</Text>
            <Text style={[styles.status, hasKey && styles.statusConnected]}>{hasKey ? 'Connected' : 'Not connected'}</Text>
          </View>
          {Platform.OS === 'web' && (
            <Pressable accessibilityRole="button" onPress={() => void beginOpenRouterOAuth().catch((error) => Alert.alert('Could not connect', String(error)))} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Connect OpenRouter</Text>
            </Pressable>
          )}
          <Text style={styles.or}>or paste an OpenRouter API key</Text>
          <View style={styles.inline}>
            <TextInput accessibilityLabel="OpenRouter API key" secureTextEntry value={apiKey} onChangeText={setApiKey} placeholder="sk-or-v1-…" placeholderTextColor="#94a3b8" style={styles.input} />
            <Pressable accessibilityRole="button" accessibilityLabel="Save OpenRouter API key" onPress={() => void saveKey()} style={styles.smallButton}><Text style={styles.smallButtonText}>Save</Text></Pressable>
          </View>
          {hasKey && (
            <>
              {Platform.OS === 'web' && (
                <Pressable accessibilityRole="button" onPress={() => void makeShareLink()} style={styles.shareButton}>
                  <Text style={styles.shareButtonText}>🔗 Create friend link</Text>
                </Pressable>
              )}
              {!!shareLink && (
                <View style={styles.shareBox}>
                  <Text style={styles.label}>Friend link</Text>
                  <TextInput accessibilityLabel="Friend link" value={shareLink} editable={false} multiline selectTextOnFocus style={[styles.input, styles.shareLink]} />
                  <Pressable accessibilityRole="button" onPress={() => void copyShareLink()} style={styles.smallButton}><Text style={styles.smallButtonText}>Copy link</Text></Pressable>
                  <Text style={styles.warning}>
                    Anyone with this link can spend through this key until you revoke it. Prefer a dedicated OpenRouter key with a spending limit. The ?ort= value packs the standard 64-character hexadecimal key body into 32 raw bytes and base64url, making the shared value about one-third shorter while hiding the obvious sk-or-v1- prefix from dumb scrapers. It is not encryption.
                  </Text>
                </View>
              )}
              <Pressable accessibilityRole="button" onPress={() => void clearOpenRouterKey().then(() => { setHasKey(false); setShareLink(''); })} style={styles.textButton}>
                <Text style={styles.dangerLink}>Disconnect provider</Text>
              </Pressable>
            </>
          )}
          <Text style={styles.label}>Model</Text>
          <TextInput accessibilityLabel="OpenRouter model" value={app.settings.model} onChangeText={(model) => app.updateSettings({ model })} autoCapitalize="none" style={styles.input} placeholder="openrouter/free" />
          <Text style={styles.help}>Default is openrouter/free. You can paste any OpenRouter model slug here.</Text>
        </Section>

        <Section title="Local models" subtitle="Architecture is ready for a WebLLM/on-device provider adapter, but it is intentionally not in the MVP critical path.">
          <View style={styles.comingSoon}><Text style={styles.comingSoonText}>Experimental local Chef — planned for the final phase</Text></View>
        </Section>
      </ScrollView>
    </Screen>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <View style={styles.section}><Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionSubtitle}>{subtitle}</Text><View style={styles.sectionBody}>{children}</View></View>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, backgroundColor: '#f8fafc' },
  back: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  backGlyph: { width: 20, height: 16, position: 'relative' },
  backShaft: { position: 'absolute', left: 3, right: 1, top: 7, height: 2, borderRadius: 1, backgroundColor: '#475569' },
  backHeadTop: { position: 'absolute', left: 2, top: 4, width: 9, height: 2, borderRadius: 1, backgroundColor: '#475569', transform: [{ rotate: '-45deg' }] },
  backHeadBottom: { position: 'absolute', left: 2, bottom: 4, width: 9, height: 2, borderRadius: 1, backgroundColor: '#475569', transform: [{ rotate: '45deg' }] },
  title: { fontSize: 22, fontWeight: '800', color: '#172033' },
  content: { padding: 16, paddingBottom: 60, gap: 16, maxWidth: 760, width: '100%', alignSelf: 'center' },
  section: { backgroundColor: 'white', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 20, padding: 18 },
  sectionTitle: { color: '#172033', fontSize: 19, fontWeight: '800' },
  sectionSubtitle: { color: '#64748b', lineHeight: 19, marginTop: 4 },
  sectionBody: { gap: 12, marginTop: 16 },
  label: { color: '#334155', fontWeight: '700' },
  help: { color: '#64748b', fontSize: 12.5, lineHeight: 18 },
  warning: { color: '#92400e', fontSize: 12.5, lineHeight: 18 },
  inline: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  buttonRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 200, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: '#cbd5e1', paddingHorizontal: 12, paddingVertical: 9, color: '#172033', backgroundColor: '#fff' },
  prompt: { minHeight: 210 },
  primaryButton: { minHeight: 44, backgroundColor: '#172033', borderRadius: 13, paddingHorizontal: 15, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: 'white', fontWeight: '700', textAlign: 'center' },
  smallButton: { minHeight: 44, backgroundColor: '#e2e8f0', borderRadius: 12, paddingHorizontal: 15, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  smallButtonText: { color: '#334155', fontWeight: '700', textAlign: 'center' },
  shareButton: { minHeight: 44, backgroundColor: '#ecfdf5', borderRadius: 12, paddingHorizontal: 15, paddingVertical: 10, borderWidth: 1, borderColor: '#a7f3d0', alignItems: 'center', justifyContent: 'center' },
  shareButtonText: { color: '#166534', fontWeight: '700', textAlign: 'center' },
  shareBox: { backgroundColor: '#fffbeb', borderRadius: 12, padding: 12, gap: 9, borderWidth: 1, borderColor: '#fde68a' },
  shareLink: { maxHeight: 104, fontSize: 12 },
  or: { color: '#94a3b8', textAlign: 'center', fontSize: 12 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  status: { color: '#b45309', fontWeight: '700' },
  statusConnected: { color: '#166534' },
  textButton: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  dangerLink: { color: '#b91c1c', fontWeight: '600' },
  tags: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  tag: { backgroundColor: '#fee2e2', borderRadius: 999, paddingHorizontal: 11, paddingVertical: 7 },
  tagText: { color: '#991b1b', fontWeight: '600' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  comingSoon: { backgroundColor: '#f1f5f9', padding: 14, borderRadius: 12 },
  comingSoonText: { color: '#475569', fontWeight: '600' }
});
