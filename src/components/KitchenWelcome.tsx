import { Platform, Pressable, Text, View } from 'react-native';
import { AdmissionRulePicker, type AdmissionRuleDraft } from '@/loro/app/AdmissionRulePicker';
import { RecoveryStart } from '@/loro/app/RecoveryStart';
import { SetupDisclosure, SetupScreen, setupStyles as styles, useSetupColors } from './SetupScreen';

export function KitchenWelcome({ admissionRule, onAdmissionRuleChange, onStart, canStart, error }: {
  admissionRule: AdmissionRuleDraft;
  onAdmissionRuleChange: (draft: AdmissionRuleDraft) => void;
  onStart: () => void;
  canStart: boolean;
  error: string | null;
}) {
  const colors = useSetupColors();
  const supported = Platform.OS === 'web' || Platform.OS === 'android';
  return (
    <SetupScreen>
      <View style={{ gap: 12 }}>
        <Text style={[styles.eyebrow, { color: colors.accent }]}>EVERYDAY INGREDIENTS, FRESH IDEAS</Text>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Welcome to Creative Cooking</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>Find new ways to enjoy what’s already in your kitchen.</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Start with something simple</Text>
        <Text style={[styles.body, { color: colors.muted }]}><Text style={{ fontWeight: '700', color: colors.text }}>Your pantry.</Text> Add a few ingredients you have. A name is enough.</Text>
        <Text style={[styles.body, { color: colors.muted }]}><Text style={{ fontWeight: '700', color: colors.text }}>Your recipes.</Text> Try a built-in idea, save a copy, and make it your own. Plan a shop for anything missing.</Text>
        <Text style={[styles.small, { color: colors.accent }]}>No account needed. Your kitchen works offline.</Text>
      </View>

      <View style={{ gap: 10 }}>
        {supported ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canStart }} disabled={!canStart}
          onPress={onStart} style={[styles.button, { backgroundColor: colors.primary }, !canStart && styles.disabled]}>
          <Text style={styles.buttonText}>Set up my kitchen</Text>
        </Pressable> : <Text style={[styles.body, { color: colors.muted }]}>Kitchen setup is currently available in a web browser or the Android app.</Text>}
        <Text style={[styles.small, { color: colors.muted }]}>Next, review your privacy settings. Your kitchen is saved on this device; sharing is optional.</Text>
        {supported && !canStart ? <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>Open Household options and choose a valid invitation rule before continuing.</Text> : null}
        {error ? <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>{error}</Text> : null}
      </View>

      <View style={[styles.card, { backgroundColor: colors.soft, borderColor: colors.border }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>What about Chef?</Text>
        <Text style={[styles.body, { color: colors.muted }]}>{Platform.OS === 'web'
          ? 'Cloud Chef is temporarily unavailable. You can keep private cooking notes now. A compatible web browser can also run an experimental on-device Chef after an optional model download.'
          : 'Chef is not available in the native app yet. You can browse recipe ideas, save your own recipes, and use Pantry and Shopping now.'}</Text>
      </View>

      {supported ? <SetupDisclosure title="Household options">
        <Text style={[styles.body, { color: colors.muted }]}>Your kitchen starts with just you. If you invite other adults later, this rule decides how many existing adults must approve each invitation.</Text>
        <View style={{ backgroundColor: '#ffffff', padding: 16, borderRadius: 16 }}>
          <AdmissionRulePicker draft={admissionRule} onChange={onAdmissionRuleChange} adults={1} />
        </View>
      </SetupDisclosure> : null}
      {Platform.OS === 'web' ? <SetupDisclosure title="Recover an existing kitchen" preserveContent>
        <Text style={[styles.body, { color: colors.muted }]}>Have an encrypted personal archive or a guardian recovery request? Open the recovery controls below.</Text>
        <View style={{ backgroundColor: '#ffffff', padding: 16, borderRadius: 16 }}><RecoveryStart /></View>
      </SetupDisclosure> : null}
      <SetupDisclosure title="Looking for an older kitchen?">
        <Text style={[styles.body, { color: colors.muted }]}>Data from the former PowerSync workspace stays on this device and can be opened with the archived PowerSync app. Setting up a kitchen here does not import or delete that data.</Text>
      </SetupDisclosure>
    </SetupScreen>
  );
}
