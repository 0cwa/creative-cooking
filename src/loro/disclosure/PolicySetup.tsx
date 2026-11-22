import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SetupDisclosure, setupStyles as styles, useSetupColors } from '@/components/SetupScreen';
import { acceptInitialPolicy, prepareInitialPolicy } from './setup.mjs';

function needsKitchenReopen(failure: unknown) {
  return failure instanceof Error && ['INVALID_AUTHORITY', 'INVALID_PREDECESSOR', 'INITIAL_POLICY_REQUIRES_SOLE_ADULT', 'CONFLICT'].includes(failure.message);
}

export function PolicySetup({ service, provider, deviceId, onAccepted, onBack, onReopen }: {
  service: any; provider: any; deviceId: string; onAccepted: () => void; onBack?: () => void; onReopen: () => void;
}) {
  const colors = useSetupColors();
  const [endpoint, setEndpoint] = useState('');
  const [block, setBlock] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [reopenNeeded, setReopenNeeded] = useState(false);
  const inFlight = useRef(false);

  // Preparing only reads the verified authority. Nothing is signed or published
  // until the person accepts the exact draft displayed below.
  useEffect(() => {
    let active = true;
    setPreparing(true);
    setError('');
    setDraft(null);
    void prepareInitialPolicy({ service, endpoint: endpoint.trim() || null, enforcement: block ? 'block' : 'preference' })
      .then(policy => { if (active) setDraft(policy); })
      .catch(failure => {
        if (!active) return;
        if (needsKitchenReopen(failure)) {
          setReopenNeeded(true);
          setError('Your kitchen changed while this screen was open. Open it again to use its current settings.');
        } else {
          setError(failure instanceof Error && failure.message === 'MALFORMED'
            ? 'Enter a complete http:// or https:// recipient URL without a password, fragment, or unsupported query, or leave it blank.'
            : 'Your privacy settings could not be prepared. Try again; your kitchen has been kept.');
        }
      })
      .finally(() => { if (active) setPreparing(false); });
    return () => { active = false; };
  }, [service, endpoint, block, prepareAttempt]);

  const accept = async () => {
    if (!draft || preparing || reopenNeeded || inFlight.current) return;
    inFlight.current = true;
    setAccepting(true);
    setError('');
    try {
      await acceptInitialPolicy({ service, provider, deviceId, policy: draft, explicit: true });
      onAccepted();
    } catch (failure) {
      if (needsKitchenReopen(failure)) {
        setReopenNeeded(true);
        setError('Your kitchen changed while this screen was open. Open it again to use its current settings.');
      } else {
        setError('Your privacy settings could not be saved. Please try again. Your kitchen has been kept.');
      }
    } finally {
      inFlight.current = false;
      setAccepting(false);
    }
  };
  const externalRecipients: string[] = draft?.access
    .filter((access: any) => access.destinations.includes('external'))
    .flatMap((access: any) => access.recipients) ?? [];
  const blocksExternal = draft?.rules.some((rule: any) => rule.enforcement === 'block');

  return <View style={{ gap: 24 }}>
    <View style={{ gap: 12 }}>
      <Text style={[styles.eyebrow, { color: colors.accent }]}>STEP 2 OF 2 · PRIVACY</Text>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Your kitchen, your privacy</Text>
      <Text style={[styles.subtitle, { color: colors.muted }]}>Check these settings, then you’re ready to cook.</Text>
    </View>

    {draft ? <View testID="privacy-summary" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.body, { color: colors.text }]}><Text style={{ fontWeight: '800' }}>Saved on this device.</Text> Your pantry, recipes, and shopping list stay here unless you choose to share or export them.</Text>
      <Text style={[styles.body, { color: colors.text }]}><Text style={{ fontWeight: '800' }}>On-device cooking is allowed.</Text> {blocksExternal
        ? 'External processing is blocked by your on-device rule.'
        : 'On-device processing is preferred. Any future external request needs a separate review.'}</Text>
      <Text style={[styles.body, { color: colors.text }]}><Text style={{ fontWeight: '800' }}>Permitted external recipients: {externalRecipients.length ? externalRecipients.join(', ') : 'none'}.</Text> Cloud Chef is currently unavailable. Accepting these settings does not connect a cloud service.</Text>
    </View> : preparing ? <Text accessibilityRole="progressbar" accessibilityLabel="Preparing your privacy settings" style={[styles.body, { color: colors.muted }]}>Preparing your privacy settings…</Text> : null}

    <View style={{ gap: 10 }}>
      {error ? <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>{error}</Text> : null}
      {reopenNeeded ? <Pressable accessibilityRole="button" onPress={onReopen} style={[styles.button, { backgroundColor: colors.primary }]}>
        <Text style={styles.buttonText}>Open kitchen again</Text>
      </Pressable> : draft ? <>
        <Pressable accessibilityRole="button" accessibilityLabel="Accept settings and open my kitchen" accessibilityState={{ disabled: accepting || preparing, busy: accepting || preparing }} disabled={accepting || preparing}
          onPress={() => void accept()} style={[styles.button, { backgroundColor: colors.primary }, (accepting || preparing) && styles.disabled]}>
          <Text style={styles.buttonText}>{accepting ? 'Saving settings…' : 'Accept settings and open my kitchen'}</Text>
        </Pressable>
        <Text style={[styles.small, { color: colors.muted }]}>Next: add an ingredient in Pantry or explore the recipe ideas. You can change privacy settings later in Settings.</Text>
      </> : !preparing ? <Pressable accessibilityRole="button" onPress={() => setPrepareAttempt(value => value + 1)} style={[styles.button, { backgroundColor: colors.primary }]}>
        <Text style={styles.buttonText}>Try preparing settings again</Text>
      </Pressable> : null}
      {onBack && !reopenNeeded ? <Pressable accessibilityRole="button" disabled={accepting} onPress={onBack} style={styles.disclosure}>
        <Text style={[styles.disclosureText, { color: colors.muted, textAlign: 'center' }]}>Back to welcome</Text>
      </Pressable> : null}
    </View>

    <SetupDisclosure title="Advanced privacy options">
      <Text style={[styles.body, { color: colors.muted }]}>You can leave the recipient blank. A permitted recipient is an exact service endpoint, not an API key. Adding one does not enable Cloud Chef.</Text>
      <TextInput accessibilityLabel="Optional permitted recipient endpoint" placeholder="Optional permitted recipient endpoint"
        placeholderTextColor={colors.muted} value={endpoint} editable={!accepting && !reopenNeeded} autoCapitalize="none" autoCorrect={false}
        onChangeText={value => { setEndpoint(value); setDraft(null); setError(''); }}
        style={[styles.input, { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface }]} />
      <Pressable accessibilityRole="checkbox" aria-checked={block} accessibilityState={{ checked: block, disabled: accepting || reopenNeeded }} disabled={accepting || reopenNeeded}
        onPress={() => { setBlock(value => !value); setDraft(null); setError(''); }} style={styles.checkbox}>
        <Text style={[styles.body, { color: colors.text }]}>{block ? '☑' : '☐'}</Text>
        <Text style={[styles.body, { flex: 1, color: colors.text }]}>Block external processing instead of allowing a reviewed preference override</Text>
      </Pressable>
      <Text style={[styles.small, { color: colors.muted }]}>The default is a preference for on-device processing. If external requests become available, each request needs a review. Overriding a preference records your disagreement; it is not consent from other adults. A blocking rule prevents that override.</Text>
      <Text style={[styles.small, { color: colors.muted }]}>These choices apply to new cooking changes. They do not automatically approve older items for external processing.</Text>
    </SetupDisclosure>

    {draft ? <SetupDisclosure title="Show policy details">
        <Text style={[styles.small, { color: colors.muted }]}>Accepting records your approval of this exact policy for new cooking changes. You are the only person in this new kitchen.</Text>
        <Text selectable style={[styles.small, { color: colors.muted }]}>{JSON.stringify(draft, null, 2)}</Text>
      </SetupDisclosure> : null}
  </View>;
}
