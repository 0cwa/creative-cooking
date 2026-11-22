import { Platform, Pressable, Text, View } from 'react-native';
import { AdmissionRulePicker, type AdmissionRuleDraft } from '@/loro/app/AdmissionRulePicker';
import { RecoveryStart } from '@/loro/app/RecoveryStart';
import { SetupDisclosure, SetupScreen, setupStyles as styles, useSetupColors } from './SetupScreen';
import { kitchenStartupErrorMessage } from './KitchenStartupStatus';

export function KitchenWelcome({ admissionRule, onAdmissionRuleChange, onStart, canStart, error, resuming = false }: {
  admissionRule: AdmissionRuleDraft;
  onAdmissionRuleChange: (draft: AdmissionRuleDraft) => void;
  onStart: () => void;
  canStart: boolean;
  error: string | null;
  resuming?: boolean;
}) {
  const colors = useSetupColors();
  const supported = Platform.OS === 'web' || Platform.OS === 'android';
  return (
    <SetupScreen>
      <View style={{ gap: 12 }}>
        <Text style={[styles.eyebrow, { color: colors.accent }]}>STEP 1 OF 2 · WELCOME</Text>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Welcome to Creative Cooking</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>A few ingredients. A fresh idea for dinner.</Text>
        <Text style={[styles.body, { color: colors.muted }]}>Keep track of what you have, explore recipe ideas, and make them your own.</Text>
      </View>

      <View style={{ gap: 10 }}>
        {supported ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canStart }} disabled={!canStart}
          onPress={onStart} style={[styles.button, { backgroundColor: colors.primary }, !canStart && styles.disabled]}>
          <Text style={styles.buttonText}>Set up my kitchen</Text>
        </Pressable> : <Text style={[styles.body, { color: colors.muted }]}>Kitchen setup is currently available in a web browser or the Android app.</Text>}
        <Text style={[styles.small, { color: colors.muted }]}>{resuming
          ? 'Your kitchen is ready to finish setting up. Continue to the privacy check; no new kitchen will be created.'
          : 'Next: a quick privacy check, then your kitchen opens. No account or payment details needed.'}</Text>
        {supported && !canStart ? <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>Open Household options and choose a valid invitation rule before continuing.</Text> : null}
        {error ? <>
          <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>{kitchenStartupErrorMessage(error)}</Text>
          <SetupDisclosure title="Show technical details"><Text selectable style={[styles.small, { color: colors.muted }]}>{error}</Text></SetupDisclosure>
        </> : null}
      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Start small</Text>
        <Text style={[styles.body, { color: colors.muted }]}>Add one ingredient in Pantry, or go straight to Recipes for a complete idea to try. You can save recipes and plan a shop for anything missing.</Text>
        <Text style={[styles.small, { color: colors.accent }]}>Saved on this device. Works offline once the app has loaded.</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.soft, borderColor: colors.border }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>What about Chef?</Text>
        <Text style={[styles.body, { color: colors.muted }]}>{Platform.OS === 'web'
          ? 'Cloud Chef is temporarily unavailable. You can keep private cooking notes now. A compatible web browser can also run an experimental on-device Chef after an optional model download.'
          : 'Chef is not available in the native app yet. You can browse recipe ideas, save your own recipes, and use Pantry and Shopping now.'}</Text>
      </View>

      {Platform.OS === 'web' ? <SetupDisclosure title="Recover an existing kitchen" preserveContent>
        <Text style={[styles.body, { color: colors.muted }]}>Have an encrypted personal archive or a guardian recovery request? Open the recovery controls below.</Text>
        <View style={{ backgroundColor: '#ffffff', padding: 16, borderRadius: 16 }}><RecoveryStart /></View>
      </SetupDisclosure> : null}
      <SetupDisclosure title="More setup options" preserveContent>
        {supported && !resuming ? <SetupDisclosure title="Household options" preserveContent>
          <Text style={[styles.body, { color: colors.muted }]}>Your kitchen starts with just you. You can manage invitations later in Settings. If you already know which approval rule you want, choose it here.</Text>
          <View style={{ backgroundColor: '#ffffff', padding: 16, borderRadius: 16 }}>
            <AdmissionRulePicker draft={admissionRule} onChange={onAdmissionRuleChange} adults={1} />
          </View>
        </SetupDisclosure> : null}
        <SetupDisclosure title="Looking for an older kitchen?">
          <Text style={[styles.body, { color: colors.muted }]}>Data from the former PowerSync workspace stays on this device and can be opened with the archived PowerSync app. Setting up a kitchen here does not import or delete that data.</Text>
        </SetupDisclosure>
      </SetupDisclosure>
    </SetupScreen>
  );
}
