import { HouseholdReadmission } from '@/loro/app/HouseholdReadmission';
import { HouseholdRevocation } from '@/loro/app/HouseholdRevocation';
import { HouseholdDraftRotation } from '@/loro/app/HouseholdDraftRotation';
import { HouseholdAdultRemoval } from '@/loro/app/HouseholdAdultRemoval';
import { HouseholdCompromise } from '@/loro/app/HouseholdCompromise';
import { HouseholdExistingDevice } from '@/loro/app/HouseholdExistingDevice';
import { HouseholdGrantReview } from '@/loro/app/HouseholdGrantReview';
import { HouseholdDelegation } from '@/loro/app/HouseholdDelegation';
import { HouseholdApproval } from '@/loro/app/HouseholdApproval';
import { HouseholdAdmissionRule } from '@/loro/app/HouseholdAdmissionRule';
import { CookingDirect } from '@/loro/app/CookingDirect';
import { HouseholdLocalTrust } from '@/loro/app/HouseholdLocalTrust';
import { CookingExchange } from '@/loro/app/CookingExchange';
import { HouseholdInvitation } from '@/loro/app/HouseholdInvitation';
import { HouseholdIdentity } from '@/loro/app/HouseholdIdentity';
import { DisclosureControls } from '@/loro/app/DisclosureControls';
import { HouseholdOwnDevice } from '@/loro/app/HouseholdOwnDevice';
import { PersonalDevicePairing } from '@/loro/app/PersonalDevicePairing';
import { PersonalAuthority } from '@/loro/app/PersonalAuthority';
import { RecoveryReminder } from '@/loro/app/RecoveryReminder';
import { LoroWorkspaceStatus } from '@/loro/app/WorkspaceStatus';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Platform, Pressable, ScrollView, Share, Switch, Text, TextInput, View } from 'react-native';
import { StyleSheet, themeColor } from '@/theme/StyleSheet';
import { useAppTheme } from '@/theme/theme';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Screen } from '@/components/Screen';
import { DEFAULT_SYSTEM_PROMPT } from '@/domain/defaults';
import { THEME_PREFERENCES, type DictationEngine, type ProviderId } from '@/domain/types';
import { beginOpenRouterOAuth } from '@/llm/openrouter/oauth';
import { createOpenRouterShareLink } from '@/llm/openrouter/share';
import { CLOUD_PROVIDER_IDS, modelCapabilities, providerMetadata } from '@/llm/registry';
import { getLocalInferenceCapabilities } from '@/llm/webllm/capabilities';
import {
  WEBLLM_MODEL_ID,
  type LocalCapabilityResult
} from '@/llm/webllm/capabilityPolicy';
import {
  deleteLocalModel,
  downloadLocalModel,
  isLocalModelCached
} from '@/llm/webllm/modelCache';
import { getOnDeviceDictationSupport } from '@/speech/dictation';
import {
  deleteWhisperModel,
  downloadWhisperModel,
  getWhisperModelCapabilities,
  isWhisperModelCached,
  WHISPER_MODEL_ESTIMATED_DOWNLOAD_MB,
  WHISPER_MODEL_ID,
  type WhisperCapabilityResult,
  type WhisperDownloadProgress
} from '@/speech/whisperModel';
import {
  clearProviderKey,
  getOpenRouterKey,
  getProviderKey,
  setProviderKey
} from '@/storage/credentialVault';
import { useAppState } from '@/state/AppState';

function formatBytes(value?: number): string {
  if (!value || value < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function supportLabel(value: boolean | 'unknown'): string {
  return value === 'unknown' ? 'Unknown' : value ? 'Yes' : 'No';
}

function localChefCompatibilityMessage(reason: string): string {
  if (reason === 'Local WebLLM is currently available only in the PWA.') return 'Open Creative Cooking in a compatible web browser to try Local Chef.';
  if (reason === 'WebGPU is unavailable in this browser.') return 'This browser does not provide the graphics support Local Chef needs. Try an up-to-date browser or another device.';
  if (reason === 'Web Workers are unavailable in this browser.') return 'This browser cannot run Local Chef in the background. Try another browser.';
  return reason;
}

export default function SettingsScreen() {
  useAppTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ focus?: string }>();
  const app = useAppState();
  const [quarantineChanged, setQuarantineChanged] = useState(0);
  const [allergyInput, setAllergyInput] = useState('');
  const [deviceTimeContext, setDeviceTimeContext] = useState<string | null>(null);
  const [browserDictationSupport, setBrowserDictationSupport] = useState<ReturnType<typeof getOnDeviceDictationSupport> | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [localCapability, setLocalCapability] = useState<LocalCapabilityResult | null>(null);
  const [localModelCached, setLocalModelCached] = useState<boolean | null>(null);
  const [localModelBusy, setLocalModelBusy] = useState(false);
  const [localModelStatus, setLocalModelStatus] = useState('');
  const [whisperCapability, setWhisperCapability] = useState<WhisperCapabilityResult | null>(null);
  const [whisperModelCached, setWhisperModelCached] = useState<boolean | null>(null);
  const [whisperModelBusy, setWhisperModelBusy] = useState(false);
  const [whisperModelStatus, setWhisperModelStatus] = useState('');
  const [whisperDownloadProgress, setWhisperDownloadProgress] = useState<WhisperDownloadProgress | null>(null);
  const localDownloadController = useRef<AbortController | null>(null);
  const whisperDownloadController = useRef<AbortController | null>(null);
  const settingsScrollRef = useRef<ScrollView>(null);
  const dictationFocusHandledRef = useRef(false);
  const localChefFocusHandledRef = useRef(false);

  useEffect(() => {
    const localTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown zone';
    setDeviceTimeContext(`${localTime} · ${timeZone}`);
    setBrowserDictationSupport(getOnDeviceDictationSupport('browser'));
  }, []);

  const provider = providerMetadata(app.settings.providerId);
  const capabilities = modelCapabilities(app.settings.providerId, app.settings.model);
  const cloudChefUnavailable = app.storageMode === 'fresh-local';
  const browserDictationAvailable = browserDictationSupport?.available === true;
  const whisperDictationReady = whisperCapability?.available === true && whisperModelCached === true;

  useEffect(() => {
    let active = true;
    void getProviderKey(app.settings.providerId).then((value) => {
      if (active) setHasKey(Boolean(value));
    });
    setApiKey('');
    setShareLink('');
    return () => {
      active = false;
    };
  }, [app.settings.providerId]);

  const refreshLocalState = async () => {
    const [capability, cached, voiceCapability, voiceCached] = await Promise.all([
      getLocalInferenceCapabilities(),
      isLocalModelCached(WEBLLM_MODEL_ID).catch(() => false),
      getWhisperModelCapabilities(),
      isWhisperModelCached().catch(() => false)
    ]);
    setLocalCapability(capability);
    setLocalModelCached(cached);
    setWhisperCapability(voiceCapability);
    setWhisperModelCached(voiceCached);
  };

  useEffect(() => {
    void refreshLocalState();

    return () => {
      localDownloadController.current?.abort();
      whisperDownloadController.current?.abort();
    };
  }, []);

  const downloadModel = async () => {
    if (!localCapability?.available || localModelBusy) return;

    const controller = new AbortController();
    localDownloadController.current = controller;
    setLocalModelBusy(true);
    setLocalModelStatus('Starting local model download…');

    try {
      await downloadLocalModel(
        WEBLLM_MODEL_ID,
        (status) => setLocalModelStatus(status),
        controller.signal
      );
      setLocalModelCached(true);
      setLocalModelStatus('Local model downloaded and ready.');
      await refreshLocalState();
      Alert.alert('Local model ready', 'The experimental local Chef can now run without an API key.');
    } catch (error) {
      if (controller.signal.aborted) {
        await deleteLocalModel(WEBLLM_MODEL_ID).catch(() => undefined);
        setLocalModelCached(false);
        setLocalModelStatus('');
      } else {
        setLocalModelStatus('');
        Alert.alert(
          'Local model download failed',
          error instanceof Error ? error.message : 'Unknown error'
        );
        await refreshLocalState();
      }
    } finally {
      if (localDownloadController.current === controller) localDownloadController.current = null;
      setLocalModelBusy(false);
    }
  };

  const cancelModelDownload = () => {
    localDownloadController.current?.abort();
    setLocalModelStatus('Canceling local model download…');
  };

  const deleteDownloadedModel = () => {
    Alert.alert(
      'Delete downloaded local model?',
      'This frees the space used by the local Chef download. Your pantry, recipes, notes, and saved provider keys are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete model',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setLocalModelBusy(true);
              setLocalModelStatus('Deleting local model…');
              try {
                await deleteLocalModel(WEBLLM_MODEL_ID);
                setLocalModelCached(false);
                setLocalModelStatus('');
                if (app.settings.providerId === 'webllm') {
                  const fallback = providerMetadata('openrouter');
                  app.updateSettings({ providerId: 'openrouter', model: fallback.defaultModel });
                }
                await refreshLocalState();
              } catch (error) {
                setLocalModelStatus('');
                Alert.alert(
                  'Could not delete local model',
                  error instanceof Error ? error.message : 'Unknown error'
                );
              } finally {
                setLocalModelBusy(false);
              }
            })();
          }
        }
      ]
    );
  };

  const downloadVoiceModel = async () => {
    if (!whisperCapability?.available || whisperModelBusy) return;

    const controller = new AbortController();
    whisperDownloadController.current = controller;
    setWhisperModelBusy(true);
    setWhisperModelStatus('Starting local voice-model download…');
    setWhisperDownloadProgress(null);

    try {
      await downloadWhisperModel(
        (progress) => {
          setWhisperModelStatus(progress.message);
          setWhisperDownloadProgress(progress);
        },
        controller.signal
      );
      setWhisperModelCached(true);
      setWhisperModelStatus('Local voice model downloaded and ready.');
      await refreshLocalState();
      Alert.alert(
        'Local dictation ready',
        'Creative Cooking can now use the downloaded Whisper model when browser-native on-device speech is unavailable.'
      );
    } catch (error) {
      if (controller.signal.aborted) {
        await deleteWhisperModel().catch(() => undefined);
        setWhisperModelCached(false);
        setWhisperModelStatus('');
        setWhisperDownloadProgress(null);
      } else {
        setWhisperModelStatus('');
        setWhisperDownloadProgress(null);
        Alert.alert(
          'Voice model download failed',
          error instanceof Error ? error.message : 'Unknown error'
        );
        await refreshLocalState();
      }
    } finally {
      if (whisperDownloadController.current === controller) whisperDownloadController.current = null;
      setWhisperModelBusy(false);
    }
  };

  const cancelVoiceModelDownload = () => {
    whisperDownloadController.current?.abort();
    setWhisperModelStatus('Canceling voice-model download…');
  };

  const deleteDownloadedVoiceModel = () => {
    Alert.alert(
      'Delete downloaded voice model?',
      'This frees the Whisper model cache. Dictation will keep using browser-native on-device speech wherever the browser provides it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete model',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setWhisperModelBusy(true);
              setWhisperModelStatus('Deleting local voice model…');
              try {
                await deleteWhisperModel();
                setWhisperModelCached(false);
                setWhisperModelStatus('');
                setWhisperDownloadProgress(null);
                await refreshLocalState();
              } catch (error) {
                setWhisperModelStatus('');
                Alert.alert(
                  'Could not delete voice model',
                  error instanceof Error ? error.message : 'Unknown error'
                );
              } finally {
                setWhisperModelBusy(false);
              }
            })();
          }
        }
      ]
    );
  };

  const snapshot = () => ({
    pantry: app.pantry,
    recipes: app.recipes,
    shopping: app.shopping,
    chatMessages: app.chatMessages,
    chatHistory: app.chatHistory,
    activeConversationId: app.activeConversationId,
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

  const selectProvider = (providerId: ProviderId) => {
    const next = providerMetadata(providerId);
    app.updateSettings({ providerId, model: next.defaultModel });
  };

  const selectDictationEngine = (dictationEngine: DictationEngine) => {
    app.updateSettings({ dictationEngine });
  };

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    await setProviderKey(app.settings.providerId, apiKey.trim());
    setApiKey('');
    setHasKey(true);
    Alert.alert(
      `${provider.name} key saved`,
      Platform.OS === 'web' ? 'Stored only in this browser.' : 'Stored in the device secure store.'
    );
  };

  const makeShareLink = async () => {
    try {
      const key = await getOpenRouterKey();
      if (!key) throw new Error('Connect an OpenRouter key first.');
      const link = await createOpenRouterShareLink(key);
      setShareLink(link);
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(link);
          Alert.alert('Share link copied', 'Send it only to someone you trust. The complete link grants use of this OpenRouter key.');
        }
      } else {
        await Share.share({
          title: 'Creative Cooking OpenRouter friend link',
          message: `Creative Cooking OpenRouter friend link:\n${link}`,
          url: link
        });
      }
    } catch (error) {
      Alert.alert('Could not create share link', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const copyShareLink = async () => {
    if (!shareLink) return;

    if (Platform.OS === 'web') {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(shareLink);
    } else {
      await Clipboard.setStringAsync(shareLink);
    }

    Alert.alert('Copied', 'Share link copied to the clipboard.');
  };

  const resetMasterInstructions = () => {
    Alert.alert(
      'Reset master instructions?',
      'This replaces your customized master instructions with the Creative Cooking defaults. Your other settings are unchanged.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset instructions',
          style: 'destructive',
          onPress: () => app.updateSettings({ systemPrompt: DEFAULT_SYSTEM_PROMPT })
        }
      ]
    );
  };

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
      <ScrollView ref={settingsScrollRef} contentContainerStyle={styles.content}>
        <Section title="Allergies" subtitle="These are hard constraints and are sent with meal requests.">
          <View style={styles.inline}>
            <TextInput accessibilityLabel="Add allergies" value={allergyInput} onChangeText={setAllergyInput} onSubmitEditing={addAllergies} placeholder="e.g. peanuts, shellfish" placeholderTextColor={themeColor('#94a3b8')} style={styles.input} />
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
              <Text style={styles.help}>{deviceTimeContext ?? 'Shown from this device when Settings opens'}</Text>
            </View>
            <Switch accessibilityLabel="Send local time and time zone" value={app.settings.sendLocalTime} onValueChange={(sendLocalTime) => app.updateSettings({ sendLocalTime })} />
          </View>
          <Text style={styles.label}>City</Text>
          <TextInput accessibilityLabel="City" value={app.settings.city} onChangeText={(city) => app.updateSettings({ city })} placeholder="e.g. Stockholm" placeholderTextColor={themeColor('#94a3b8')} style={styles.input} />
          <Text style={styles.help}>City is enough; the app does not need precise GPS location.</Text>
        </Section>

        <Section title="Appearance" subtitle="Choose how Creative Cooking looks. System follows your device and updates automatically.">
          <View style={styles.providerGrid}>
            {THEME_PREFERENCES.map((theme) => {
              const label = theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark';
              const accessibilityLabel = theme === 'system'
                ? 'Follow system theme'
                : theme === 'light'
                  ? 'Use light theme'
                  : 'Use dark theme';
              return (
                <Pressable
                  key={theme}
                  accessibilityRole="radio"
                  accessibilityLabel={accessibilityLabel}
                  accessibilityState={{ checked: app.settings.theme === theme }}
                  aria-checked={app.settings.theme === theme}
                  onPress={() => app.updateSettings({ theme })}
                  style={[
                    styles.providerButton,
                    app.settings.theme === theme && styles.providerButtonActive
                  ]}
                >
                  <Text style={[
                    styles.providerButtonText,
                    app.settings.theme === theme && styles.providerButtonTextActive
                  ]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        <View
          testID="local-chef-settings"
          onLayout={(event) => {
            if (params.focus !== 'local-chef' || localChefFocusHandledRef.current
              || !localCapability || !whisperCapability || localModelCached === null || whisperModelCached === null) return;
            localChefFocusHandledRef.current = true;
            const y = Math.max(0, event.nativeEvent.layout.y - 12);
            setTimeout(() => settingsScrollRef.current?.scrollTo({ y, animated: false }), 0);
          }}
        >
        <Section title="Local Chef" subtitle="Optional cooking suggestions that run on this device. You need a compatible web browser and one download; no account or API key is needed.">
          <View style={styles.capabilityBox}>
            <Text style={styles.capabilityTitle}>Download once, then ask for ideas</Text>
            <Text style={styles.help}>Keep at least 1.5 GB of free browser storage for the download. Once it is ready, choose Use local Chef below.</Text>
            <Text style={styles.warning}>Local Chef is experimental and gives text suggestions only. Add ingredients and save recipes yourself.</Text>
            {app.settings.allergies.length > 0 && (
              <Text style={styles.warning}>Local Chef is unavailable while allergies are set because it cannot reliably check its suggestions against them.</Text>
            )}
          </View>

          {localCapability ? (
            <>
              <View style={styles.statusRow}>
                <Text style={styles.label}>Browser compatibility</Text>
                <Text style={[styles.status, localCapability.available && styles.statusConnected]}>{localCapability.available ? 'Available' : 'Unavailable'}</Text>
              </View>
              <View style={styles.statusRow}>
                <Text style={styles.label}>Free browser storage</Text>
                <Text style={[styles.status, localCapability.available && styles.statusConnected]}>
                  {localCapability.freeBytes === undefined ? 'Unknown' : formatBytes(localCapability.freeBytes)}
                </Text>
              </View>
              {Platform.OS === 'web' && !localCapability.persistent && (
                <Text style={styles.help}>If your browser clears the download to free space, you can download it again.</Text>
              )}
              {localCapability.reasons.map((reason) => (
                <Text key={reason} style={styles.warning}>• {localChefCompatibilityMessage(reason)}</Text>
              ))}
              <View style={styles.statusRow}>
                <Text style={styles.label}>Model cache</Text>
                <Text style={[styles.status, localModelCached && styles.statusConnected]}>
                  {localModelCached === null ? 'Checking…' : localModelCached ? 'Downloaded' : 'Not downloaded'}
                </Text>
              </View>
              {!!localModelStatus && <Text accessibilityLiveRegion="polite" style={styles.help}>{localModelStatus}</Text>}
              {localModelCached === false && (
                <Text style={styles.help}>The download starts only when you choose Download model. Chef will not start a hidden download from the chat screen.</Text>
              )}
              <View style={styles.buttonRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Refresh local model compatibility"
                  disabled={localModelBusy}
                  onPress={() => void refreshLocalState()}
                  style={[styles.smallButton, localModelBusy && styles.disabledButton]}
                >
                  <Text style={styles.smallButtonText}>Refresh compatibility</Text>
                </Pressable>
                {localModelCached === false && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={localModelBusy ? 'Cancel local model download' : 'Download local model'}
                    disabled={!localCapability.available && !localModelBusy}
                    onPress={localModelBusy ? cancelModelDownload : () => void downloadModel()}
                    style={[
                      styles.smallButton,
                      (!localCapability.available && !localModelBusy) && styles.disabledButton
                    ]}
                  >
                    <Text style={styles.smallButtonText}>{localModelBusy ? 'Cancel download' : 'Download model'}</Text>
                  </Pressable>
                )}
                {localModelCached === true && !localModelBusy && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Delete downloaded local model"
                    onPress={deleteDownloadedModel}
                    style={styles.textButton}
                  >
                    <Text style={styles.dangerLink}>Delete downloaded model</Text>
                  </Pressable>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Use experimental local Chef"
                  accessibilityState={{
                    selected: app.settings.providerId === 'webllm',
                    disabled: !localCapability.available || !localModelCached || localModelBusy || app.settings.allergies.length > 0
                  }}
                  disabled={!localCapability.available || !localModelCached || localModelBusy || app.settings.allergies.length > 0}
                  onPress={() => selectProvider('webllm')}
                  style={[
                    styles.primaryButton,
                    (!localCapability.available || !localModelCached || localModelBusy || app.settings.allergies.length > 0) && styles.disabledButton
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    {app.settings.providerId === 'webllm' ? 'Using local Chef' : 'Use local Chef'}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : (
            <Text style={styles.help}>Checking whether this browser can run Local Chef…</Text>
          )}
        </Section>
        </View>



        <Section title="Master instructions" subtitle="Customize Chef’s style and priorities. Tool behavior, safety constraints, and app mechanics are managed separately and cannot be edited here.">
          <TextInput accessibilityLabel="Master instructions" value={app.settings.systemPrompt} onChangeText={(systemPrompt) => app.updateSettings({ systemPrompt })} multiline style={[styles.input, styles.prompt]} textAlignVertical="top" />
          {app.settings.systemPrompt !== DEFAULT_SYSTEM_PROMPT && (
            <Pressable accessibilityRole="button" accessibilityLabel="Reset master instructions to default" onPress={resetMasterInstructions} style={styles.textButton}>
              <Text style={styles.resetLink}>Reset to default instructions</Text>
            </Pressable>
          )}
        </Section>

        <View
          onLayout={(event) => {
            if (params.focus !== 'dictation' || dictationFocusHandledRef.current) return;
            dictationFocusHandledRef.current = true;
            const y = Math.max(0, event.nativeEvent.layout.y - 12);
            setTimeout(() => settingsScrollRef.current?.scrollTo({ y, animated: false }), 0);
          }}
        >
        <Section title="Dictation" subtitle="Turn speech into text on this device. Voice input is separate from Chef’s recipe suggestions.">
          <View style={styles.capabilityBox}>
            <Text style={styles.capabilityTitle}>Voice input</Text>
            <Text style={styles.help}>Choose what the microphone button beside the Chef text field uses. You can change this any time.</Text>
            <View accessibilityRole="radiogroup" style={styles.providerGrid}>
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel="Use browser dictation engine"
                aria-checked={app.settings.dictationEngine === 'browser'}
                aria-disabled={!browserDictationAvailable}
                accessibilityState={{ checked: app.settings.dictationEngine === 'browser', disabled: !browserDictationAvailable }}
                disabled={!browserDictationAvailable}
                onPress={() => selectDictationEngine('browser')}
                style={[
                  styles.providerButton,
                  app.settings.dictationEngine === 'browser' && styles.providerButtonActive,
                  !browserDictationAvailable && styles.disabledButton
                ]}
              >
                <Text style={[
                  styles.providerButtonText,
                  app.settings.dictationEngine === 'browser' && styles.providerButtonTextActive
                ]}>Browser speech</Text>
              </Pressable>
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel="Use Whisper dictation engine"
                aria-checked={app.settings.dictationEngine === 'whisper'}
                aria-disabled={!whisperDictationReady}
                accessibilityState={{ checked: app.settings.dictationEngine === 'whisper', disabled: !whisperDictationReady }}
                disabled={!whisperDictationReady}
                onPress={() => selectDictationEngine('whisper')}
                style={[
                  styles.providerButton,
                  app.settings.dictationEngine === 'whisper' && styles.providerButtonActive,
                  !whisperDictationReady && styles.disabledButton
                ]}
              >
                <Text style={[
                  styles.providerButtonText,
                  app.settings.dictationEngine === 'whisper' && styles.providerButtonTextActive
                ]}>
                  {whisperModelCached ? 'Whisper' : 'Whisper · download first'}
                </Text>
              </Pressable>
            </View>
            {browserDictationSupport === null && (
              <Text style={styles.help}>Checking browser speech support…</Text>
            )}
            {browserDictationSupport !== null && !browserDictationAvailable && (
              <Text style={styles.warning}>Browser speech is unavailable here. Download Whisper below, then select it as the dictation engine.</Text>
            )}
            {app.settings.dictationEngine === 'browser' && browserDictationAvailable && (
              <Text style={styles.help}>Chef’s mic currently uses your browser’s on-device English speech.</Text>
            )}
            {app.settings.dictationEngine === 'whisper' && whisperDictationReady && (
              <Text style={styles.help}>Chef’s mic currently uses the downloaded Whisper model entirely on this device.</Text>
            )}
            {app.settings.dictationEngine === 'whisper' && !whisperDictationReady && (
              <Text style={styles.warning}>Whisper is selected but is not ready. Download it below, or switch back to Browser speech if that option is available.</Text>
            )}
          </View>

          <View style={styles.capabilityBox}>
            <Text style={styles.capabilityTitle}>Whisper Tiny download</Text>
            <Text style={styles.help}>Model: {WHISPER_MODEL_ID}</Text>
            <Text style={styles.help}>
              Optional fallback for browsers without native on-device speech. Download is roughly {WHISPER_MODEL_ESTIMATED_DOWNLOAD_MB} MB; at least 250 MB of free browser storage is recommended.
            </Text>
            <Text style={styles.warning}>
              Browser-native on-device speech remains preferred. The Whisper fallback also stays entirely on this device; microphone audio is never sent to a transcription service.
            </Text>
          </View>

          {whisperCapability ? (
            <>
              <View style={styles.statusRow}>
                <Text style={styles.label}>Voice-model compatibility</Text>
                <Text style={[styles.status, whisperCapability.available && styles.statusConnected]}>
                  {whisperCapability.available ? 'Available' : 'Unavailable'}
                </Text>
              </View>
              <View style={styles.statusRow}>
                <Text style={styles.label}>Voice model cache</Text>
                <Text style={[styles.status, whisperModelCached && styles.statusConnected]}>
                  {whisperModelCached === null ? 'Checking…' : whisperModelCached ? 'Downloaded' : 'Not downloaded'}
                </Text>
              </View>
              {whisperCapability.freeBytes !== undefined && (
                <Text style={styles.help}>Free browser storage: {formatBytes(whisperCapability.freeBytes)}</Text>
              )}
              {whisperCapability.reasons.map((reason) => (
                <Text key={reason} style={styles.warning}>• {reason}</Text>
              ))}
              {whisperDownloadProgress && (
                <View accessibilityLiveRegion="polite" style={styles.downloadProgressCard}>
                  <View style={styles.downloadProgressHeader}>
                    <Text style={styles.downloadProgressTitle}>
                      {whisperDownloadProgress.phase === 'ready' ? 'Voice model ready' : 'Downloading voice model'}
                    </Text>
                    <Text style={styles.downloadProgressPercent}>{whisperDownloadProgress.percent}%</Text>
                  </View>
                  <View
                    accessibilityRole="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={whisperDownloadProgress.percent}
                    aria-valuetext={`${whisperDownloadProgress.percent}% · ${formatBytes(whisperDownloadProgress.loadedBytes)} of ${formatBytes(whisperDownloadProgress.totalBytes)}`}
                    accessibilityValue={{
                      min: 0,
                      max: 100,
                      now: whisperDownloadProgress.percent
                    }}
                    style={styles.downloadProgressTrack}
                  >
                    <View
                      style={[
                        styles.downloadProgressFill,
                        { width: `${Math.max(2, whisperDownloadProgress.percent)}%` }
                      ]}
                    />
                  </View>
                  <View style={styles.downloadProgressMeta}>
                    <Text style={styles.help}>{whisperModelStatus}</Text>
                    <Text style={styles.downloadProgressBytes}>
                      {formatBytes(whisperDownloadProgress.loadedBytes)} / {formatBytes(whisperDownloadProgress.totalBytes)}
                    </Text>
                  </View>
                </View>
              )}
              {!whisperDownloadProgress && !!whisperModelStatus && (
                <Text accessibilityLiveRegion="polite" style={styles.help}>{whisperModelStatus}</Text>
              )}
              <View style={styles.buttonRow}>
                {whisperModelCached === false && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={whisperModelBusy ? 'Cancel voice model download' : 'Download local voice model'}
                    disabled={!whisperCapability.available && !whisperModelBusy}
                    onPress={whisperModelBusy ? cancelVoiceModelDownload : () => void downloadVoiceModel()}
                    style={[
                      styles.smallButton,
                      (!whisperCapability.available && !whisperModelBusy) && styles.disabledButton
                    ]}
                  >
                    <Text style={styles.smallButtonText}>
                      {whisperModelBusy ? 'Cancel download' : 'Download voice model'}
                    </Text>
                  </Pressable>
                )}
                {whisperModelCached === true && !whisperModelBusy && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Delete downloaded voice model"
                    onPress={deleteDownloadedVoiceModel}
                    style={styles.textButton}
                  >
                    <Text style={styles.dangerLink}>Delete voice model</Text>
                  </Pressable>
                )}
              </View>
            </>
          ) : (
            <Text style={styles.help}>Checking local voice-model compatibility…</Text>
          )}

        </Section>
        </View>

        <Section title="Data & Storage" subtitle="Your local workspace is stored on this device.">
          <Text testID="settings-local-persistence-status" accessibilityLiveRegion="polite" style={styles.help}>
            {app.localPersistenceStatus === 'saved' ? 'Saved locally' : app.localPersistenceStatus === 'saving' ? 'Saving locally' : 'Local save failed'}
          </Text>
          {app.localPersistenceStatus === 'error' && <Pressable accessibilityRole="button" onPress={() => void app.retryStorage()} style={styles.smallButton}><Text style={styles.smallButtonText}>Retry local storage</Text></Pressable>}
          {Platform.OS === 'web' && <RecoveryReminder />}
        </Section>

        <SettingsDisclosure title="Household and advanced tools" subtitle="Optional sharing, device pairing, privacy rules, and recovery tools for a shared kitchen. You do not need these to cook on this device.">
            <LoroWorkspaceStatus revision={app.localPersistenceStatus} />
            <PersonalDevicePairing />
            <PersonalAuthority />
            <HouseholdIdentity />
            <HouseholdOwnDevice />
            <HouseholdInvitation />
            <HouseholdApproval />
            <HouseholdAdmissionRule />
            <HouseholdDelegation />
            <HouseholdGrantReview />
            <HouseholdExistingDevice />
            <HouseholdLocalTrust onQuarantine={() => setQuarantineChanged(changed => changed + 1)} />
            <HouseholdCompromise />
            <HouseholdAdultRemoval />
            <HouseholdDraftRotation />
            <HouseholdRevocation />
            {Platform.OS === 'web' && <HouseholdReadmission />}
            <CookingDirect />
            <CookingExchange quarantineChanged={quarantineChanged} />
            {Platform.OS === 'web' && <DisclosureControls items={app.pantry} />}
        </SettingsDisclosure>

        <SettingsDisclosure title={cloudChefUnavailable ? "Saved cloud connections" : "Chef provider"} initiallyOpen={!cloudChefUnavailable} subtitle={cloudChefUnavailable
          ? 'Cloud Chef is temporarily unavailable. You can manage previously saved keys here. New connections are unavailable while cloud replies are disabled. Recipe ideas and Local Chef do not need a key.'
          : 'Choose a cloud provider and bring your own API key. Credentials stay outside ordinary app state and backups.'}>
          <Text style={styles.label}>{cloudChefUnavailable ? 'Saved provider preference' : 'Provider'}</Text>
          {cloudChefUnavailable && <Text style={styles.help}>Choose which provider’s settings and saved key to manage. This changes your saved provider preference; it does not enable cloud replies.</Text>}
          <View style={styles.providerGrid}>
            {CLOUD_PROVIDER_IDS.map((providerId) => {
              const option = providerMetadata(providerId);
              const selected = app.settings.providerId === providerId;
              return (
                <Pressable
                  key={providerId}
                  accessibilityRole="button"
                  accessibilityLabel={`Use ${option.name} provider`}
                  accessibilityState={{ selected }}
                  onPress={() => selectProvider(providerId)}
                  style={[styles.providerButton, selected && styles.providerButtonActive]}
                >
                  <Text style={[styles.providerButtonText, selected && styles.providerButtonTextActive]}>{option.name}</Text>
                </Pressable>
              );
            })}
          </View>

          {provider.credentialRequired ? (
            <>
          <View style={styles.statusRow}>
            <Text style={styles.label}>{provider.name} connection</Text>
            <Text style={[styles.status, hasKey && styles.statusConnected]}>{hasKey ? 'Key saved' : 'No key saved'}</Text>
          </View>

          {!cloudChefUnavailable && <>
          {app.settings.providerId === 'openrouter' && Platform.OS === 'web' && (
            <Pressable accessibilityRole="button" onPress={() => void beginOpenRouterOAuth().catch((error) => Alert.alert('Could not connect', String(error)))} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Connect OpenRouter</Text>
            </Pressable>
          )}

          <Text style={styles.or}>
            {app.settings.providerId === 'openrouter' && Platform.OS === 'web'
              ? 'or paste an API key'
              : `Paste your ${provider.name} API key`}
          </Text>
          <View style={styles.inline}>
            <TextInput
              accessibilityLabel={provider.apiKeyLabel}
              secureTextEntry
              value={apiKey}
              onChangeText={setApiKey}
              placeholder="API key"
              placeholderTextColor={themeColor('#94a3b8')}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <Pressable accessibilityRole="button" accessibilityLabel={`Save ${provider.name} API key`} onPress={() => void saveKey()} style={styles.smallButton}>
              <Text style={styles.smallButtonText}>Save</Text>
            </Pressable>
          </View>
          </>}

          {hasKey && (
            <>
              {app.settings.providerId === 'openrouter' && (
                <Pressable accessibilityRole="button" onPress={() => void makeShareLink()} style={styles.shareButton}>
                  <Text style={styles.shareButtonText}>{Platform.OS === 'web' ? '🔗 Create friend link' : '🔗 Share friend link'}</Text>
                </Pressable>
              )}
              {!!shareLink && app.settings.providerId === 'openrouter' && (
                <View style={styles.shareBox}>
                  <Text style={styles.label}>Friend link</Text>
                  <TextInput accessibilityLabel="Friend link" value={shareLink} editable={false} multiline selectTextOnFocus style={[styles.input, styles.shareLink]} />
                  <Pressable accessibilityRole="button" onPress={() => void copyShareLink()} style={styles.smallButton}><Text style={styles.smallButtonText}>Copy link</Text></Pressable>
                  <Text style={styles.warning}>
                    Anyone with the complete link can use this key until you revoke it. Share it only with someone you trust, and use a dedicated OpenRouter key with a spending limit. The link hides the key from plain view but does not encrypt it.
                  </Text>
                </View>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={() => void clearProviderKey(app.settings.providerId).then(() => {
                  setHasKey(false);
                  setShareLink('');
                })}
                style={styles.textButton}
              >
                <Text style={styles.dangerLink}>Disconnect {provider.name}</Text>
              </Pressable>
            </>
          )}

          <Text style={styles.label}>Model</Text>
          <TextInput
            accessibilityLabel={`${provider.name} model`}
            value={app.settings.model}
            onChangeText={(model) => app.updateSettings({ model })}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder={provider.defaultModel}
          />
          <Text style={styles.help}>
            Default: {provider.defaultModel}. You can paste another model ID; unknown models are allowed without guessing their capabilities.
          </Text>

          <View style={styles.capabilityBox}>
            <Text style={styles.capabilityTitle}>{cloudChefUnavailable ? 'Saved model settings · cloud replies unavailable' : 'Model capabilities'}</Text>
            <Text style={styles.help}>Tool calling: {supportLabel(capabilities.toolCalling)} · Streaming: {supportLabel(capabilities.streaming)} · Structured output: {supportLabel(capabilities.structuredOutput)} · Free/free-tier: {supportLabel(capabilities.freeTier)}</Text>
            {capabilities.toolCalling === false && (
              <Text style={styles.warning}>This model supports text suggestions only. It cannot change Pantry or save recipes.</Text>
            )}
            {capabilities.toolCalling === 'unknown' && (
              <Text style={styles.help}>Tool support is unknown for this custom model ID.</Text>
            )}
          </View>
            </>
          ) : (
            <View style={styles.capabilityBox}>
              <Text style={styles.capabilityTitle}>Experimental local Chef is active</Text>
              <Text style={styles.help}>{app.storageMode === 'fresh-local'
                ? 'Local Chef uses a downloaded model in this browser. Cloud replies remain unavailable for this kitchen.'
                : 'Select a cloud provider above to switch back to a hosted model.'}</Text>
            </View>
          )}
        </SettingsDisclosure>
      </ScrollView>
    </Screen>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <View style={styles.section}><Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionSubtitle}>{subtitle}</Text><View style={styles.sectionBody}>{children}</View></View>;
}

function SettingsDisclosure({ title, subtitle, initiallyOpen = false, children }: {
  title: string; subtitle: string; initiallyOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [opened, setOpened] = useState(initiallyOpen);
  return (
    <View style={styles.section}>
      <Pressable accessibilityRole="button" accessibilityLabel={title} aria-expanded={open}
        accessibilityState={{ expanded: open }} onPress={() => { setOpened(true); setOpen(value => !value); }}
        style={styles.disclosureHeading}>
        <Text style={[styles.sectionTitle, { flex: 1 }]}>{title}</Text>
        <Text aria-hidden style={styles.disclosureIndicator}>{open ? '−' : '+'}</Text>
      </Pressable>
      <Text style={styles.sectionSubtitle}>{subtitle}</Text>
      {opened && <View accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
        style={[styles.sectionBody, !open && { display: 'none' }]}>{children}</View>}
    </View>
  );
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
  disclosureHeading: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 },
  disclosureIndicator: { color: '#64748b', fontSize: 24 },
  label: { color: '#334155', fontWeight: '700' },
  help: { color: '#64748b', fontSize: 12.5, lineHeight: 18 },
  warning: { color: '#92400e', fontSize: 12.5, lineHeight: 18 },
  storageErrorBox: { backgroundColor: '#fff7ed', borderRadius: 12, padding: 12, gap: 9, borderWidth: 1, borderColor: '#fdba74' },
  storageErrorTitle: { color: '#9a3412', fontWeight: '800' },
  inline: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  providerGrid: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  providerButton: { minHeight: 42, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: '#e2e8f0', justifyContent: 'center' },
  providerButtonActive: { backgroundColor: '#172033' },
  providerButtonText: { color: '#475569', fontWeight: '700' },
  providerButtonTextActive: { color: 'white' },
  capabilityBox: { backgroundColor: '#f8fafc', borderRadius: 12, padding: 12, gap: 6, borderWidth: 1, borderColor: '#e2e8f0' },
  capabilityTitle: { color: '#334155', fontWeight: '800' },
  downloadProgressCard: { backgroundColor: '#f0fdf4', borderRadius: 14, padding: 12, gap: 9, borderWidth: 1, borderColor: '#bbf7d0' },
  downloadProgressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  downloadProgressTitle: { color: '#166534', fontWeight: '800', fontSize: 14 },
  downloadProgressPercent: { color: '#166534', fontWeight: '800', fontVariant: ['tabular-nums'] },
  downloadProgressTrack: { height: 9, borderRadius: 999, backgroundColor: '#dcfce7', overflow: 'hidden' },
  downloadProgressFill: { height: '100%', borderRadius: 999, backgroundColor: '#166534' },
  downloadProgressMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
  downloadProgressBytes: { color: '#166534', fontSize: 12.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 200, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: '#cbd5e1', paddingHorizontal: 12, paddingVertical: 9, color: '#172033', backgroundColor: '#fff' },
  prompt: { minHeight: 210 },
  primaryButton: { minHeight: 44, backgroundColor: '#172033', borderRadius: 13, paddingHorizontal: 15, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: 'white', fontWeight: '700', textAlign: 'center' },
  disabledButton: { opacity: 0.4 },
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
  resetLink: { color: '#475569', fontWeight: '600' },
  tags: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  tag: { backgroundColor: '#fee2e2', borderRadius: 999, paddingHorizontal: 11, paddingVertical: 7 },
  tagText: { color: '#991b1b', fontWeight: '600' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  comingSoon: { backgroundColor: '#f1f5f9', padding: 14, borderRadius: 12 },
  comingSoonText: { color: '#475569', fontWeight: '600' }
});
