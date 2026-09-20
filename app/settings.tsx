import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { beginOpenRouterOAuth } from '@/llm/openrouter/oauth';
import { clearOpenRouterKey, getOpenRouterKey, setOpenRouterKey } from '@/storage/credentialVault';
import { useAppState } from '@/state/AppState';

export default function SettingsScreen() {
  const router = useRouter();
  const app = useAppState();
  const [allergyInput, setAllergyInput] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => { void getOpenRouterKey().then((value) => setHasKey(Boolean(value))); }, []);

  const addAllergies = () => {
    const additions = allergyInput.split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);
    if (!additions.length) return;
    const merged = [...app.settings.allergies, ...additions].filter((value, index, all) => all.findIndex((x) => x.toLocaleLowerCase() === value.toLocaleLowerCase()) === index);
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

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.back}><Text style={styles.backText}>‹</Text></Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 42 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Section title="Chef provider" subtitle="OpenRouter gives the app one login/API surface across many model providers.">
          <View style={styles.statusRow}><Text style={styles.label}>Connection</Text><Text style={[styles.status, hasKey && styles.statusConnected]}>{hasKey ? 'Connected' : 'Not connected'}</Text></View>
          {Platform.OS === 'web' && <Pressable onPress={() => void beginOpenRouterOAuth().catch((error) => Alert.alert('Could not connect', String(error)))} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Connect OpenRouter</Text></Pressable>}
          <Text style={styles.or}>or paste an OpenRouter API key</Text>
          <View style={styles.inline}><TextInput secureTextEntry value={apiKey} onChangeText={setApiKey} placeholder="sk-or-v1-…" placeholderTextColor="#94a3b8" style={styles.input} /><Pressable onPress={() => void saveKey()} style={styles.smallButton}><Text style={styles.smallButtonText}>Save</Text></Pressable></View>
          {hasKey && <Pressable onPress={() => void clearOpenRouterKey().then(() => setHasKey(false))}><Text style={styles.dangerLink}>Disconnect provider</Text></Pressable>}
          <Text style={styles.label}>Model</Text>
          <TextInput value={app.settings.model} onChangeText={(model) => app.updateSettings({ model })} autoCapitalize="none" style={styles.input} placeholder="openrouter/free" />
          <Text style={styles.help}>Default is openrouter/free. You can paste any OpenRouter model slug here.</Text>
        </Section>

        <Section title="Allergies" subtitle="These are hard constraints and are sent with meal requests.">
          <View style={styles.inline}><TextInput value={allergyInput} onChangeText={setAllergyInput} onSubmitEditing={addAllergies} placeholder="e.g. peanuts, shellfish" placeholderTextColor="#94a3b8" style={styles.input} /><Pressable onPress={addAllergies} style={styles.smallButton}><Text style={styles.smallButtonText}>Add</Text></Pressable></View>
          <View style={styles.tags}>
            {app.settings.allergies.map((allergy) => <Pressable key={allergy} onPress={() => app.updateSettings({ allergies: app.settings.allergies.filter((x) => x !== allergy) })} style={styles.tag}><Text style={styles.tagText}>{allergy} ×</Text></Pressable>)}
          </View>
        </Section>

        <Section title="Context" subtitle="Optional context for meal timing and seasonal/regional suggestions.">
          <View style={styles.toggleRow}><View style={{ flex: 1 }}><Text style={styles.label}>Send local time & time zone</Text><Text style={styles.help}>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown zone'}</Text></View><Switch value={app.settings.sendLocalTime} onValueChange={(sendLocalTime) => app.updateSettings({ sendLocalTime })} /></View>
          <Text style={styles.label}>City</Text>
          <TextInput value={app.settings.city} onChangeText={(city) => app.updateSettings({ city })} placeholder="e.g. Stockholm" placeholderTextColor="#94a3b8" style={styles.input} />
          <Text style={styles.help}>City is enough; the app does not need precise GPS location.</Text>
        </Section>

        <Section title="Chef system prompt" subtitle="Customize Chef’s style and priorities. Core tool and allergy rules are added by the app separately.">
          <TextInput value={app.settings.systemPrompt} onChangeText={(systemPrompt) => app.updateSettings({ systemPrompt })} multiline style={[styles.input, styles.prompt]} textAlignVertical="top" />
        </Section>

        <Section title="Local models" subtitle="Architecture is ready for a WebLLM/on-device provider adapter, but it is intentionally not in the MVP critical path.">
          <View style={styles.comingSoon}><Text style={styles.comingSoonText}>Experimental local Chef — planned</Text></View>
        </Section>
      </ScrollView>
    </Screen>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionSubtitle}>{subtitle}</Text><View style={styles.sectionBody}>{children}</View></View>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, backgroundColor: '#f8fafc' },
  back: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 34, lineHeight: 35, color: '#475569' },
  title: { fontSize: 22, fontWeight: '800', color: '#172033' },
  content: { padding: 16, paddingBottom: 60, gap: 16, maxWidth: 760, width: '100%', alignSelf: 'center' },
  section: { backgroundColor: 'white', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 20, padding: 18 },
  sectionTitle: { color: '#172033', fontSize: 19, fontWeight: '800' },
  sectionSubtitle: { color: '#64748b', lineHeight: 19, marginTop: 4 },
  sectionBody: { gap: 12, marginTop: 16 },
  label: { color: '#334155', fontWeight: '700' },
  help: { color: '#64748b', fontSize: 12.5, lineHeight: 18 },
  inline: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: '#cbd5e1', paddingHorizontal: 12, paddingVertical: 9, color: '#172033', backgroundColor: '#fff' },
  prompt: { minHeight: 210 },
  primaryButton: { backgroundColor: '#172033', borderRadius: 13, padding: 13, alignItems: 'center' },
  primaryButtonText: { color: 'white', fontWeight: '700' },
  smallButton: { backgroundColor: '#e2e8f0', borderRadius: 12, paddingHorizontal: 15, paddingVertical: 12 },
  smallButtonText: { color: '#334155', fontWeight: '700' },
  or: { color: '#94a3b8', textAlign: 'center', fontSize: 12 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  status: { color: '#b45309', fontWeight: '700' },
  statusConnected: { color: '#166534' },
  dangerLink: { color: '#b91c1c', fontWeight: '600' },
  tags: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  tag: { backgroundColor: '#fee2e2', borderRadius: 999, paddingHorizontal: 11, paddingVertical: 7 },
  tagText: { color: '#991b1b', fontWeight: '600' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  comingSoon: { backgroundColor: '#f1f5f9', padding: 14, borderRadius: 12 },
  comingSoonText: { color: '#475569', fontWeight: '600' }
});
