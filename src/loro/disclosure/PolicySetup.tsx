import { useEffect, useRef, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { KitchenStartupStatus } from '@/components/KitchenStartupStatus';
import { setupStyles as styles, useSetupColors } from '@/components/SetupScreen';
import { acceptInitialPolicy, prepareInitialPolicy } from './setup.mjs';

function needsKitchenReopen(failure: unknown) {
  return failure instanceof Error && ['INVALID_AUTHORITY', 'INVALID_PREDECESSOR', 'INITIAL_POLICY_REQUIRES_SOLE_ADULT', 'CONFLICT'].includes(failure.message);
}

/**
 * Accepts the default on-device-only policy for a new kitchen.
 * Render this only after the person pressed "Start cooking", which is the explicit acceptance.
 */
export function PolicySetup({ service, provider, deviceId, onAccepted, onBack, onReopen }: {
  service: any; provider: any; deviceId: string; onAccepted: () => void; onBack: () => void; onReopen: () => void;
}) {
  const colors = useSetupColors();
  const [error, setError] = useState<string | null>(null);
  const [reopenNeeded, setReopenNeeded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const accepted = useRef(onAccepted);
  accepted.current = onAccepted;

  useEffect(() => {
    let active = true;
    setError(null);
    void (async () => {
      try {
        const policy = await prepareInitialPolicy({ service, endpoint: null, enforcement: 'preference' });
        if (!active) return;
        await acceptInitialPolicy({ service, provider, deviceId, policy, explicit: true });
        if (active) accepted.current();
      } catch (failure) {
        if (!active) return;
        const detail = failure instanceof Error ? failure.message : String(failure);
        if (needsKitchenReopen(failure)) {
          setReopenNeeded(true);
          setError(`HOUSEHOLD_SELECTION_CHANGED (${detail})`);
        } else setError(detail || 'Your privacy settings could not be saved.');
      }
    })();
    return () => { active = false; };
  }, [service, provider, deviceId, attempt]);

  return <KitchenStartupStatus
    loadingTitle="Setting up your kitchen…"
    loadingDetail="Saving your on-device privacy settings."
    error={error}
    errorTitle="Your kitchen could not finish setting up"
    errorDetail="Your kitchen has been kept on this device."
    onRetry={reopenNeeded ? undefined : () => setAttempt(value => value + 1)}
  >
    {reopenNeeded ? <Pressable accessibilityRole="button" onPress={onReopen} style={[styles.button, { backgroundColor: colors.primary }]}>
      <Text style={styles.buttonText}>Open kitchen again</Text>
    </Pressable> : null}
    {error && !reopenNeeded ? <Pressable accessibilityRole="button" onPress={onBack} style={styles.disclosure}>
      <Text style={[styles.disclosureText, { color: colors.muted, textAlign: 'center' }]}>Back to welcome</Text>
    </Pressable> : null}
  </KitchenStartupStatus>;
}
