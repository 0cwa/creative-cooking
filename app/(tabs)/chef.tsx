import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { SettingsGlyph } from '@/components/SettingsGlyph';
import { MealContextModal } from '@/components/MealContextModal';
import { buildChefSystemPrompt } from '@/chef/context';
import type { ChatMessage, IngredientPreference, UiQuestion } from '@/domain/types';
import { LlmRequestError, normalizeLlmError } from '@/llm/errors';
import { providerForId } from '@/llm/providers';
import { modelCapabilities, providerMetadata } from '@/llm/registry';
import { createDictationController, getOnDeviceDictationSupport, getPreferredDictationLanguage } from '@/speech/dictation';
import { appendDictationToDraft, joinDictation } from '@/speech/transcript';
import type { DictationController, DictationSnapshot, DictationStatus } from '@/speech/dictationTypes';
import { getProviderKey } from '@/storage/credentialVault';
import { makeChatMessage, useAppState } from '@/state/AppState';

type RunErrorState = {
  error: LlmRequestError;
  messages: ChatMessage[];
  partialText: string;
};

function errorPresentation(error: LlmRequestError, providerName: string): { title: string; message: string; showSettings: boolean } {
  switch (error.kind) {
    case 'network':
      return {
        title: 'No connection to Chef',
        message: `I could not reach ${providerName}. Check your connection and try again.`,
        showSettings: false
      };
    case 'rate_limit':
      return {
        title: 'Chef is being rate-limited',
        message: `${providerName} is temporarily limiting requests. Retry in a moment.`,
        showSettings: false
      };
    case 'credits':
      return {
        title: `${providerName} credits unavailable`,
        message: 'This key has no usable credits or has reached its budget. Add credits or connect another key.',
        showSettings: true
      };
    case 'auth':
      return {
        title: `${providerName} key rejected`,
        message: `Reconnect ${providerName} or paste a valid API key in Settings.`,
        showSettings: true
      };
    case 'model_unavailable':
      return {
        title: 'Model unavailable',
        message: error.message || 'The selected model is unavailable or not allowed for this provider. Choose another model in Settings.',
        showSettings: true
      };
    case 'invalid_request':
      return {
        title: 'Request rejected',
        message: error.message || `${providerName} rejected this request. Check the selected model and settings.`,
        showSettings: true
      };
    default:
      return {
        title: 'Chef could not finish',
        message: error.retryable
          ? `${providerName} or the selected model had a temporary problem. You can retry this turn.`
          : error.message || 'The provider could not complete this turn.',
        showSettings: false
      };
  }
}

function isDictationActive(status: DictationStatus): boolean {
  return status === 'checking'
    || status === 'installing-language'
    || status === 'listening'
    || status === 'stopping';
}

function dictationStatusText(status: DictationStatus, lang: string, error: string): string {
  switch (status) {
    case 'checking':
      return `Checking the on-device speech pack for ${lang}…`;
    case 'installing-language':
      return `Installing the on-device speech pack for ${lang}…`;
    case 'listening':
      return 'Listening on device. Pauses are okay — press Stop when finished.';
    case 'stopping':
      return 'Finishing your last words…';
    case 'error':
      return error || 'On-device dictation stopped. Try again when you are ready.';
    default:
      return 'Speech stays on this device. Press Start, then Stop when you are finished.';
  }
}

export default function ChefScreen() {
  const router = useRouter();
  const app = useAppState();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [providerStatus, setProviderStatus] = useState('');
  const [runError, setRunError] = useState<RunErrorState | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [question, setQuestion] = useState<UiQuestion | null>(null);
  const [dictationStatus, setDictationStatus] = useState<DictationStatus>('idle');
  const [dictationError, setDictationError] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingTextRef = useRef('');
  const discardCancelledRef = useRef(false);
  const dictationControllerRef = useRef<DictationController | null>(null);
  const dictationBaseRef = useRef('');
  const activeProvider = providerMetadata(app.settings.providerId);
  const dictationSupport = useMemo(() => getOnDeviceDictationSupport(), []);
  const dictationLang = useMemo(() => getPreferredDictationLanguage(), []);
  const dictationActive = isDictationActive(dictationStatus);

  useEffect(() => () => {
    dictationControllerRef.current?.dispose();
  }, []);

  const stateSnapshot = useMemo(() => ({
    pantry: app.pantry,
    recipes: app.recipes,
    chatMessages: app.chatMessages,
    mealContext: app.mealContext,
    settings: app.settings
  }), [app.pantry, app.recipes, app.chatMessages, app.mealContext, app.settings]);

  const handleDictationSnapshot = (snapshot: DictationSnapshot) => {
    setDictationStatus(snapshot.status);
    setDictationError(snapshot.error ?? '');
    const dictated = joinDictation(snapshot.finalText, snapshot.interimText);
    setInput(appendDictationToDraft(dictationBaseRef.current, dictated));
  };

  const startDictation = () => {
    if (!dictationSupport.available || dictationActive) return;

    dictationBaseRef.current = input;
    setDictationError('');

    try {
      const controller = dictationControllerRef.current ?? createDictationController();
      dictationControllerRef.current = controller;
      void controller.start({
        lang: dictationLang,
        onChange: handleDictationSnapshot
      });
    } catch (error) {
      setDictationStatus('error');
      setDictationError(error instanceof Error ? error.message : 'On-device dictation could not start.');
    }
  };

  const stopDictation = () => {
    dictationControllerRef.current?.stop();
  };

  const runChef = async (messages: ChatMessage[]) => {
    setQuestion(null);
    setRunError(null);
    setStreamingText('');
    setProviderStatus('');
    streamingTextRef.current = '';
    discardCancelledRef.current = false;
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const provider = providerForId(app.settings.providerId);
      const capabilities = modelCapabilities(app.settings.providerId, app.settings.model);

      if (capabilities.location === 'local' && app.settings.allergies.length > 0) {
        app.appendChatMessage(makeChatMessage(
          'assistant',
          'Experimental local Chef is currently disabled while allergies are configured. Switch to a cloud provider in Settings; local allergy validation is still being built.'
        ));
        return;
      }

      const apiKey = activeProvider.credentialRequired
        ? await getProviderKey(app.settings.providerId)
        : '';
      if (activeProvider.credentialRequired && !apiKey) {
        app.appendChatMessage(makeChatMessage(
          'assistant',
          `Connect ${activeProvider.name} or paste an API key in Settings, then I can cook with you.`
        ));
        return;
      }

      const compiledPrompt = buildChefSystemPrompt({ ...stateSnapshot, chatMessages: messages });
      const systemPrompt = capabilities.toolCalling === false
        ? `${compiledPrompt}\n\nMODEL CAPABILITY NOTE\nThis selected model does not support application tools. Do not claim to have changed Pantry or saved a recipe; explain what the user can do manually instead.`
        : compiledPrompt;

      const result = await provider.run({
        apiKey: apiKey ?? '',
        model: app.settings.model,
        systemPrompt,
        messages,
        signal: controller.signal,
        onTextDelta: (delta) => {
          streamingTextRef.current += delta;
          setStreamingText(streamingTextRef.current);
        },
        onStatus: setProviderStatus,
        tools: capabilities.toolCalling === false ? undefined : {
          addPantry: (names, preference: IngredientPreference = 3) => app.addPantryItems(names, preference),
          removePantry: app.removePantryByName,
          setPantryPreference: app.setPantryPreferenceByName,
          saveRecipe: app.saveRecipe
        }
      });

      if (result.text.trim()) app.appendChatMessage(makeChatMessage('assistant', result.text.trim()));
      if (result.question) setQuestion(result.question);
    } catch (error) {
      const normalized = normalizeLlmError(error);
      const partialText = streamingTextRef.current.trim();

      if (normalized.kind === 'cancelled') {
        if (!discardCancelledRef.current && partialText) {
          app.appendChatMessage(makeChatMessage('assistant', partialText));
        }
      } else {
        setRunError({ error: normalized, messages, partialText });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      streamingTextRef.current = '';
      setStreamingText('');
      setProviderStatus('');
      setBusy(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    }
  };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || busy || dictationActive) return;

    setInput('');
    const userMessage = makeChatMessage('user', text);
    const messages = [...app.chatMessages, userMessage];
    app.appendChatMessage(userMessage);
    await runChef(messages);
  };

  const retry = () => {
    if (!runError?.error.retryable || busy) return;
    void runChef(runError.messages);
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const reset = () => {
    Alert.alert('Start a new chat?', 'Your pantry and saved recipes stay as they are.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'New chat',
        style: 'destructive',
        onPress: () => {
          discardCancelledRef.current = true;
          abortRef.current?.abort();
          dictationControllerRef.current?.dispose();
          dictationControllerRef.current = null;
          dictationBaseRef.current = '';
          setDictationStatus('idle');
          setDictationError('');
          setInput('');
          app.newChat();
          setQuestion(null);
          setRunError(null);
        }
      }
    ]);
  };

  const errorUi = runError ? errorPresentation(runError.error, activeProvider.name) : null;
  const dictationCopy = dictationSupport.available
    ? dictationStatusText(dictationStatus, dictationLang, dictationError)
    : dictationSupport.reason ?? 'On-device dictation is unavailable in this browser.';

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>CREATIVE COOKING</Text>
            <Text style={styles.title}>Chef</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Start a new chat" onPress={reset} style={styles.newChatButton}><Text style={styles.newChatText}>New chat</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => router.push('/settings')} style={styles.iconButton}><SettingsGlyph /></Pressable>
          </View>
        </View>

        <View style={styles.contextStrip}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={app.mealContext.willingToShop ? 'Shopping allowed' : 'Pantry only'}
            accessibilityState={{ selected: app.mealContext.willingToShop }}
            onPress={() => app.updateMealContext({ willingToShop: !app.mealContext.willingToShop })}
            style={[styles.contextChip, app.mealContext.willingToShop && styles.contextChipActive]}
          >
            <Text style={[styles.contextChipText, app.mealContext.willingToShop && styles.contextChipTextActive]}>🛒 {app.mealContext.willingToShop ? 'Can shop' : 'Pantry only'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Edit meal context, ${app.mealContext.portions} portions, ${app.mealContext.cooks.length} cooks`} onPress={() => setContextOpen(true)} style={styles.contextChip}>
            <Text style={styles.contextChipText}>{app.mealContext.portions} portions · {app.mealContext.cooks.length} cook{app.mealContext.cooks.length === 1 ? '' : 's'}</Text>
          </Pressable>
        </View>

        <ScrollView ref={scrollRef} style={styles.messages} contentContainerStyle={styles.messagesContent} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
          {app.chatMessages.length === 0 && (
            <View style={styles.welcome}>
              <Text style={styles.welcomeEmoji}>🍳</Text>
              <Text style={styles.welcomeTitle}>What sounds good?</Text>
              <Text style={styles.welcomeText}>Ask for dinner ideas, tell me what you’re craving, or dictate pantry changes in plain language.</Text>
            </View>
          )}
          {app.chatMessages.map((message) => (
            <View key={message.id} style={[styles.bubble, message.role === 'user' ? styles.userBubble : styles.chefBubble]}>
              <Text style={[styles.bubbleText, message.role === 'user' && styles.userBubbleText]}>{message.content}</Text>
            </View>
          ))}
          {busy && (
            <View accessibilityLiveRegion="polite" style={[styles.bubble, styles.chefBubble]}>
              <Text style={streamingText ? styles.bubbleText : styles.typing}>{streamingText || providerStatus || 'Chef is thinking…'}</Text>
            </View>
          )}
          {runError?.partialText ? (
            <View style={[styles.bubble, styles.chefBubble]}>
              <Text style={styles.bubbleText}>{runError.partialText}</Text>
            </View>
          ) : null}
          {runError && errorUi && (
            <View accessibilityLiveRegion="polite" style={styles.errorCard}>
              <Text style={styles.errorTitle}>{errorUi.title}</Text>
              <Text style={styles.errorText}>{errorUi.message}</Text>
              <View style={styles.errorActions}>
                {runError.error.retryable && (
                  <Pressable accessibilityRole="button" accessibilityLabel="Retry Chef response" onPress={retry} style={styles.errorPrimaryButton}>
                    <Text style={styles.errorPrimaryText}>Retry</Text>
                  </Pressable>
                )}
                {errorUi.showSettings && (
                  <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => router.push('/settings')} style={styles.errorSecondaryButton}>
                    <Text style={styles.errorSecondaryText}>Settings</Text>
                  </Pressable>
                )}
              </View>
            </View>
          )}
          {question && (
            <View style={styles.questionCard}>
              <Text style={styles.questionTitle}>{question.prompt}</Text>
              <View style={styles.questionOptions}>
                {question.options.map((option) => (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Choose ${option}`} key={option} onPress={() => void send(`For your question “${question.prompt}”, I choose: ${option}`)} style={styles.questionOption}>
                    <Text style={styles.questionOptionText}>{option}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </ScrollView>

        <View style={styles.composerArea}>
          {Platform.OS === 'web' && (
            <View style={styles.dictationBar}>
              <View style={styles.dictationInfo}>
                <View style={[styles.dictationBadge, dictationStatus === 'listening' && styles.dictationBadgeListening]}>
                  <Text style={[styles.dictationBadgeText, dictationStatus === 'listening' && styles.dictationBadgeTextListening]}>ON-DEVICE</Text>
                </View>
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.dictationHelp, dictationStatus === 'error' && styles.dictationErrorText]}
                >
                  {dictationCopy}
                </Text>
              </View>
              {dictationSupport.available && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={dictationActive ? 'Stop dictation' : 'Start dictation'}
                  accessibilityState={{ disabled: dictationStatus === 'stopping' }}
                  disabled={dictationStatus === 'stopping'}
                  onPress={dictationActive ? stopDictation : startDictation}
                  style={[
                    styles.dictationButton,
                    dictationActive && styles.dictationStopButton,
                    dictationStatus === 'stopping' && styles.dictationButtonDisabled
                  ]}
                >
                  <Text style={styles.dictationButtonText}>{dictationActive ? 'Stop dictation' : 'Start dictation'}</Text>
                </Pressable>
              )}
            </View>
          )}

          <View style={styles.composerWrap}>
            <Pressable accessibilityRole="button" accessibilityLabel="Edit meal context" onPress={() => setContextOpen(true)} style={styles.plus}><Text style={styles.plusText}>＋</Text></Pressable>
            <TextInput
              accessibilityLabel="Message Chef"
              accessibilityHint={dictationActive ? 'Press Stop dictation to edit the transcript.' : undefined}
              editable={!dictationActive}
              value={input}
              onChangeText={setInput}
              placeholder="Type or dictate to Chef…"
              placeholderTextColor="#94a3b8"
              style={[styles.composer, dictationActive && styles.composerDictating]}
              multiline
              onSubmitEditing={() => {
                if (!dictationActive) void send();
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy ? 'Stop Chef response' : 'Send message'}
              disabled={!busy && (!input.trim() || dictationActive)}
              onPress={busy ? stop : () => void send()}
              style={[styles.send, (!busy && (!input.trim() || dictationActive)) && styles.sendDisabled]}
            >
              {busy ? (
                <View style={styles.stopGlyph} />
              ) : (
                <View style={styles.sendGlyph}>
                  <View style={styles.sendShaft} />
                  <View style={styles.sendHeadLeft} />
                  <View style={styles.sendHeadRight} />
                </View>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <MealContextModal
        visible={contextOpen}
        value={app.mealContext}
        onClose={() => setContextOpen(false)}
        onChange={(mealContext) => app.updateMealContext(mealContext)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, fontWeight: '800', color: '#94a3b8' },
  title: { fontSize: 34, lineHeight: 39, fontWeight: '800', color: '#172033' },
  headerActions: { flexDirection: 'row', gap: 8 },
  newChatButton: { height: 42, borderRadius: 21, backgroundColor: '#e2e8f0', paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  newChatText: { fontSize: 13, color: '#334155', fontWeight: '700' },
  iconButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  contextStrip: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8, flexWrap: 'wrap' },
  contextChip: { minHeight: 38, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  contextChipActive: { backgroundColor: '#14532d' },
  contextChipText: { color: '#475569', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  contextChipTextActive: { color: 'white' },
  messages: { flex: 1 },
  messagesContent: { padding: 16, gap: 10, paddingBottom: 28 },
  welcome: { alignItems: 'center', paddingTop: 46, paddingHorizontal: 24, paddingBottom: 30 },
  welcomeEmoji: { fontSize: 46 },
  welcomeTitle: { fontSize: 23, fontWeight: '800', color: '#172033', marginTop: 12 },
  welcomeText: { textAlign: 'center', color: '#64748b', lineHeight: 21, marginTop: 7 },
  bubble: { maxWidth: '88%', paddingHorizontal: 15, paddingVertical: 11, borderRadius: 18 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#172033', borderBottomRightRadius: 6 },
  chefBubble: { alignSelf: 'flex-start', backgroundColor: 'white', borderWidth: 1, borderColor: '#e2e8f0', borderBottomLeftRadius: 6 },
  bubbleText: { color: '#334155', fontSize: 15.5, lineHeight: 22 },
  userBubbleText: { color: 'white' },
  typing: { color: '#64748b', fontStyle: 'italic' },
  errorCard: { backgroundColor: '#fff7ed', borderColor: '#fed7aa', borderWidth: 1, borderRadius: 18, padding: 15, gap: 8 },
  errorTitle: { color: '#9a3412', fontSize: 16, fontWeight: '800' },
  errorText: { color: '#7c2d12', fontSize: 14, lineHeight: 20 },
  errorActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  errorPrimaryButton: { minHeight: 42, borderRadius: 12, backgroundColor: '#9a3412', paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  errorPrimaryText: { color: 'white', fontWeight: '800' },
  errorSecondaryButton: { minHeight: 42, borderRadius: 12, backgroundColor: 'white', borderWidth: 1, borderColor: '#fed7aa', paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  errorSecondaryText: { color: '#9a3412', fontWeight: '800' },
  questionCard: { backgroundColor: '#fff7ed', borderColor: '#fed7aa', borderWidth: 1, borderRadius: 18, padding: 15, gap: 12 },
  questionTitle: { color: '#7c2d12', fontWeight: '700', fontSize: 16 },
  questionOptions: { gap: 8 },
  questionOption: { minHeight: 44, backgroundColor: 'white', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#fed7aa', justifyContent: 'center' },
  questionOptionText: { color: '#9a3412', fontWeight: '600' },
  composerArea: { borderTopWidth: 1, borderTopColor: '#e2e8f0', backgroundColor: 'white', paddingTop: 8 },
  dictationBar: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingHorizontal: 12, paddingBottom: 8 },
  dictationInfo: { flex: 1, minWidth: 220, flexDirection: 'row', alignItems: 'center', gap: 8 },
  dictationBadge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: '#e2e8f0' },
  dictationBadgeListening: { backgroundColor: '#dcfce7' },
  dictationBadgeText: { color: '#64748b', fontSize: 10, fontWeight: '800', letterSpacing: 0.7 },
  dictationBadgeTextListening: { color: '#166534' },
  dictationHelp: { flex: 1, color: '#64748b', fontSize: 12.5, lineHeight: 17 },
  dictationErrorText: { color: '#9a3412' },
  dictationButton: { minHeight: 38, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#14532d', alignItems: 'center', justifyContent: 'center' },
  dictationStopButton: { backgroundColor: '#991b1b' },
  dictationButtonDisabled: { opacity: 0.55 },
  dictationButtonText: { color: 'white', fontSize: 13, fontWeight: '800' },
  composerWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingBottom: 10, backgroundColor: 'white', flexWrap: 'wrap' },
  plus: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  plusText: { fontSize: 24, color: '#475569' },
  composer: { flex: 1, minWidth: 140, maxHeight: 160, minHeight: 42, borderRadius: 18, backgroundColor: '#f1f5f9', paddingHorizontal: 14, paddingVertical: 10, color: '#172033', fontSize: 15.5 },
  composerDictating: { backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0' },
  send: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#172033', alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.35 },
  sendGlyph: { width: 18, height: 20, position: 'relative' },
  sendShaft: { position: 'absolute', left: 8, top: 4, bottom: 2, width: 2, borderRadius: 1, backgroundColor: 'white' },
  sendHeadLeft: { position: 'absolute', left: 3, top: 4, width: 8, height: 2, borderRadius: 1, backgroundColor: 'white', transform: [{ rotate: '-45deg' }] },
  sendHeadRight: { position: 'absolute', right: 3, top: 4, width: 8, height: 2, borderRadius: 1, backgroundColor: 'white', transform: [{ rotate: '45deg' }] },
  stopGlyph: { width: 11, height: 11, borderRadius: 2, backgroundColor: 'white' }
});
