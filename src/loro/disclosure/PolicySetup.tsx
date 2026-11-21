import { useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SetupDisclosure, setupStyles as styles, useSetupColors } from '@/components/SetupScreen';
import { acceptInitialPolicy, prepareInitialPolicy } from './setup.mjs';

export function PolicySetup({ service, provider, deviceId, onAccepted }: {
  service: any; provider: any; deviceId: string; onAccepted: () => void;
}) {
  const colors = useSetupColors();
  const [endpoint, setEndpoint] = useState('');
  const [block, setBlock] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const prepare = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setDraft(null);
    try {
      setDraft(await prepareInitialPolicy({ service, endpoint: endpoint.trim() || null, enforcement: block ? 'block' : 'preference' }));
    } catch (failure) {
      setError(failure instanceof Error && failure.message === 'MALFORMED'
        ? 'Enter a complete http:// or https:// recipient URL without a password, fragment, or unsupported query, or leave it blank.'
        : failure instanceof Error ? failure.message : 'Could not prepare your privacy settings. Please try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const accept = async () => {
    if (!draft || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await acceptInitialPolicy({ service, provider, deviceId, policy: draft, explicit: true });
      onAccepted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save your privacy settings. Please try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const externalRecipients: string[] = draft?.access
    .filter((access: any) => access.destinations.includes('external'))
    .flatMap((access: any) => access.recipients) ?? [];
  const blocksExternal = draft?.rules.some((rule: any) => rule.enforcement === 'block');

  return <View style={{ gap: 24 }}>
    <View style={{ gap: 12 }}>
      <Text style={[styles.eyebrow, { color: colors.accent }]}>ONE LAST STEP</Text>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Your kitchen, your privacy</Text>
      <Text style={[styles.subtitle, { color: colors.muted }]}>Start on this device. You decide what can be shared.</Text>
    </View>

    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.cardTitle, { color: colors.text }]}>The starting settings</Text>
      <Text style={[styles.body, { color: colors.muted }]}>Your pantry, recipes, and shopping list are saved on this device. You don’t need an account or a provider key to use them.</Text>
      <Text style={[styles.body, { color: colors.muted }]}>Cooking data is processed on this device by default. Cloud Chef is currently unavailable; accepting these settings does not connect a cloud service.</Text>
      <Text style={[styles.small, { color: colors.muted }]}>These choices apply to new cooking changes. They do not automatically approve older items for external processing.</Text>
    </View>

    <SetupDisclosure title="Advanced privacy options">
      <Text style={[styles.body, { color: colors.muted }]}>You can leave the recipient blank. A permitted recipient is an exact service endpoint, not an API key. Adding one does not enable Cloud Chef.</Text>
      <TextInput accessibilityLabel="Optional permitted recipient endpoint" placeholder="Optional permitted recipient endpoint"
        placeholderTextColor={colors.muted} value={endpoint} editable={!busy} autoCapitalize="none" autoCorrect={false}
        onChangeText={value => { setEndpoint(value); setDraft(null); setError(''); }}
        style={[styles.input, { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface }]} />
      <Pressable accessibilityRole="checkbox" aria-checked={block} accessibilityState={{ checked: block, disabled: busy }} disabled={busy}
        onPress={() => { setBlock(value => !value); setDraft(null); setError(''); }} style={styles.checkbox}>
        <Text style={[styles.body, { color: colors.text }]}>{block ? '☑' : '☐'}</Text>
        <Text style={[styles.body, { flex: 1, color: colors.text }]}>Block external processing instead of allowing a reviewed preference override</Text>
      </Pressable>
      <Text style={[styles.small, { color: colors.muted }]}>The default is a preference for on-device processing. If external requests become available, each request needs a review. Overriding a preference records your disagreement; it is not consent from other adults. A blocking rule prevents that override.</Text>
    </SetupDisclosure>

    {!draft ? <Pressable accessibilityRole="button" accessibilityLabel="Review privacy settings" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => void prepare()}
      style={[styles.button, { backgroundColor: colors.primary }, busy && styles.disabled]}>
      <Text style={styles.buttonText}>{busy ? 'Preparing settings…' : 'Review privacy settings'}</Text>
    </Pressable> : <View testID="privacy-summary" style={[styles.card, { backgroundColor: colors.soft, borderColor: colors.border }]}>
      <Text accessibilityRole="header" style={[styles.cardTitle, { color: colors.text }]}>Review your privacy settings</Text>
      <Text style={[styles.body, { color: colors.text }]}>On-device processing: allowed for cooking.</Text>
      <Text style={[styles.body, { color: colors.text }]}>Permitted external recipients: {externalRecipients.length ? externalRecipients.join(', ') : 'none'}.</Text>
      {!externalRecipients.length ? <Text style={[styles.small, { color: colors.muted }]}>An external recipient would need to be permitted before any future external request could be reviewed.</Text> : null}
      <Text style={[styles.body, { color: colors.text }]}>{blocksExternal
        ? 'External processing: blocked by your on-device rule.'
        : 'On-device processing is preferred. Any future external request must be reviewed; a preference override is not consent from other adults.'}</Text>
      <Text style={[styles.small, { color: colors.muted }]}>You are the only adult in this new kitchen. Accepting records your approval of these settings for new cooking changes.</Text>
      <SetupDisclosure title="Show policy details">
        <Text selectable style={[styles.small, { color: colors.muted }]}>{JSON.stringify(draft, null, 2)}</Text>
      </SetupDisclosure>
      <Pressable accessibilityRole="button" accessibilityLabel="Accept settings and open my kitchen" accessibilityState={{ disabled: busy }} disabled={busy}
        onPress={() => void accept()} style={[styles.button, { backgroundColor: colors.primary }, busy && styles.disabled]}>
        <Text style={styles.buttonText}>{busy ? 'Saving settings…' : 'Accept settings and open my kitchen'}</Text>
      </Pressable>
    </View>}
    {error ? <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>{error}</Text> : null}
  </View>;
}
