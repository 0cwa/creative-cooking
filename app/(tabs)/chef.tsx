import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet, themeColor } from '@/theme/StyleSheet';
import { useAppTheme } from '@/theme/theme';
import { useFocusEffect, useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { ConversationHistoryModal } from '@/components/ConversationHistoryModal';
import { SettingsGlyph } from '@/components/SettingsGlyph';
import { MealContextModal } from '@/components/MealContextModal';
import { ToolProposalCard } from '@/components/ToolProposalCard';
import { buildChefSystemPrompt } from '@/chef/context';
import { proposalFingerprint } from '@/chef/proposals';
import type { ChatMessage, ChefToolProposal, IngredientPreference, UiQuestion } from '@/domain/types';
import { LlmRequestError, normalizeLlmError } from '@/llm/errors';
import { applyChefProposal } from '@/llm/toolExecution';
import { providerForId } from '@/llm/providers';
import { modelCapabilities, providerMetadata } from '@/llm/registry';
import { createDictationController, getOnDeviceDictationSupport, getPreferredDictationLanguage } from '@/speech/dictation';
import { appendDictationToDraft, joinDictation } from '@/speech/transcript';
import type { DictationController, DictationSnapshot, DictationStatus } from '@/speech/dictationTypes';
import { isWhisperModelCached, WHISPER_MODEL_ESTIMATED_DOWNLOAD_MB } from '@/speech/whisperModel';
import { getProviderKey } from '@/storage/credentialVault';
import { makeChatMessage, useAppState } from '@/state/AppState';

type RunErrorState = {
  error: LlmRequestError;
  messages: ChatMessage[];
  partialText: string;
};

type DictationDialogState = {
  title: string;
  message: string;
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
    || status === 'loading-model'
    || status === 'listening'
    || status === 'stopping';
}

export default function ChefScreen() {
  useAppTheme();
  const router = useRouter();
  const app = useAppState();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [providerStatus, setProviderStatus] = useState('');
  const [runError, setRunError] = useState<RunErrorState | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [question, setQuestion] = useState<UiQuestion | null>(null);
  const [dictationStatus, setDictationStatus] = useState<DictationStatus>('idle');
  const [dictationDialog, setDictationDialog] = useState<DictationDialogState | null>(null);
  const [whisperModelCached, setWhisperModelCached] = useState<boolean | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingTextRef = useRef('');
  const discardCancelledRef = useRef(false);
  const dictationControllerRef = useRef<DictationController | null>(null);
  const dictationBaseRef = useRef('');
  const activeProvider = providerMetadata(app.settings.providerId);
  const dictationEngine = app.settings.dictationEngine;
  const dictationSupport = useMemo(() => getOnDeviceDictationSupport(dictationEngine), [dictationEngine]);
  const dictationLang = useMemo(() => getPreferredDictationLanguage(), []);
  const dictationActive = isDictationActive(dictationStatus);
  const whisperNeedsSetup = dictationEngine === 'whisper' && whisperModelCached !== true;

  useFocusEffect(useCallback(() => {
    let active = true;
    void isWhisperModelCached()
      .then((cached) => {
        if (active) setWhisperModelCached(cached);
      })
      .catch(() => {
        if (active) setWhisperModelCached(false);
      });
    return () => {
      active = false;
    };
  }, []));

  useEffect(() => () => {
    dictationControllerRef.current?.dispose();
  }, []);

  useEffect(() => {
    dictationControllerRef.current?.dispose();
    dictationControllerRef.current = null;
    setDictationStatus('idle');
  }, [dictationEngine]);

  const stateSnapshot = useMemo(() => ({
    pantry: app.pantry,
    recipes: app.recipes,
    chatMessages: app.chatMessages,
    chatHistory: app.chatHistory,
    activeConversationId: app.activeConversationId,
    mealContext: app.mealContext,
    settings: app.settings
  }), [app.pantry, app.recipes, app.chatMessages, app.chatHistory, app.activeConversationId, app.mealContext, app.settings]);

  const showDictationRecovery = (reason?: string) => {
    const detail = reason?.trim() ?? '';

    if (/microphone permission|microphone access|no microphone|audio-capture/i.test(detail)) {
      setDictationDialog({
        title: 'Microphone access needed',
        message: 'Creative Cooking could not use your microphone. Check this site’s microphone permission in your browser, then try again. Dictation settings also lets you choose a different on-device engine.'
      });
      return;
    }

    if (dictationEngine === 'browser') {
      setDictationDialog({
        title: 'Browser dictation unavailable',
        message: 'This browser’s built-in on-device dictation is not available here. Open Dictation settings to switch to Whisper; if Whisper is not downloaded yet, you can download it there.'
      });
      return;
    }

    if (whisperModelCached !== true) {
      setDictationDialog({
        title: 'Whisper needs a download',
        message: `Whisper runs locally, but its voice model is not ready on this device. Open Dictation settings to download it once (about ${WHISPER_MODEL_ESTIMATED_DOWNLOAD_MB} MB), then try the mic again.`
      });
      return;
    }

    setDictationDialog({
      title: 'Dictation could not start',
      message: 'Whisper could not start on this device. Open Dictation settings to switch engines or check whether the local voice model is supported here.'
    });
  };

  const handleDictationSnapshot = (snapshot: DictationSnapshot) => {
    setDictationStatus(snapshot.status);
    if (snapshot.status === 'error') showDictationRecovery(snapshot.error);
    const dictated = joinDictation(snapshot.finalText, snapshot.interimText);
    setInput(appendDictationToDraft(dictationBaseRef.current, dictated));
  };

  const startDictation = () => {
    if (dictationActive) return;

    if (!dictationSupport.available) {
      showDictationRecovery(dictationSupport.reason);
      return;
    }

    if (dictationEngine === 'whisper' && whisperModelCached === null) {
      setDictationDialog({
        title: 'Checking Whisper',
        message: 'Creative Cooking is still checking whether the local Whisper model is downloaded. Open Dictation settings to see its status, or try the mic again in a moment.'
      });
      return;
    }

    if (whisperNeedsSetup) {
      showDictationRecovery();
      return;
    }

    dictationBaseRef.current = input;

    try {
      const controller = dictationControllerRef.current ?? createDictationController(dictationEngine);
      dictationControllerRef.current = controller;
      void controller.start({
        lang: dictationLang,
        onChange: handleDictationSnapshot
      }).catch((error) => {
        setDictationStatus('error');
        showDictationRecovery(error instanceof Error ? error.message : undefined);
      });
    } catch (error) {
      setDictationStatus('error');
      showDictationRecovery(error instanceof Error ? error.message : undefined);
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

    const proposedChanges: ChefToolProposal[] = [];
    const proposalKeys = new Set<string>();
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
          updatePantry: app.updatePantryByName,
          removePantry: app.removePantryByName,
          setPantryPreference: app.setPantryPreferenceByName,
          saveRecipe: app.saveRecipe,
          validateRecipe: app.validateRecipe,
          propose: (proposal) => {
            const key = proposalFingerprint(proposal);
            if (proposalKeys.has(key)) return;
            proposalKeys.add(key);
            proposedChanges.push(proposal);
          }
        }
      });

      const responseText = result.text.trim();
      if (responseText || proposedChanges.length) {
        app.appendChatMessage(makeChatMessage(
          'assistant',
          responseText || 'I have a suggested change for you.',
          proposedChanges
        ));
      }
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

  const applyProposal = (messageId: string, proposal: ChefToolProposal): boolean => {
    try {
      const outcome = applyChefProposal(proposal, {
        addPantry: (names, preference: IngredientPreference = 3) => app.addPantryItems(names, preference),
        updatePantry: app.updatePantryByName,
        removePantry: app.removePantryByName,
        setPantryPreference: app.setPantryPreferenceByName,
        saveRecipe: app.saveRecipe,
        validateRecipe: app.validateRecipe
      });

      let result: { ok?: boolean; message?: string; error?: string } = {};
      try {
        result = JSON.parse(outcome.result) as typeof result;
      } catch {
        throw new Error('Chef returned an unreadable change result.');
      }
      if (result.ok !== true) {
        throw new Error(result.message || result.error || 'That change could not be applied.');
      }

      app.setChatProposalStatus(messageId, proposal.id, 'applied');
      return true;
    } catch (error) {
      Alert.alert(
        'Could not apply change',
        error instanceof Error ? error.message : 'That suggested change could not be applied.'
      );
      return false;
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

  const prepareConversationChange = () => {
    discardCancelledRef.current = true;
    abortRef.current?.abort();
    dictationControllerRef.current?.dispose();
    dictationControllerRef.current = null;
    dictationBaseRef.current = '';
    setDictationStatus('idle');
    setDictationDialog(null);
    setInput('');
    setQuestion(null);
    setRunError(null);
  };

  const startNewChat = () => {
    prepareConversationChange();
    app.newChat();
  };

  const openConversation = (id: string) => {
    prepareConversationChange();
    app.openChatConversation(id);
    setHistoryOpen(false);
  };

  const errorUi = runError ? errorPresentation(runError.error, activeProvider.name) : null;

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>CREATIVE COOKING</Text>
            <Text style={styles.title}>Chef</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Open previous chats" onPress={() => setHistoryOpen(true)} style={styles.historyButton}>
              <Text style={styles.historyText}>Chats{app.chatHistory.length ? ` ${app.chatHistory.length}` : ''}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Start a new chat" onPress={startNewChat} style={styles.newChatButton}><Text style={styles.newChatText}>New chat</Text></Pressable>
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
            <View key={message.id} style={styles.messageGroup}>
              <View style={[styles.bubble, message.role === 'user' ? styles.userBubble : styles.chefBubble]}>
                <Text style={[styles.bubbleText, message.role === 'user' && styles.userBubbleText]}>{message.content}</Text>
              </View>
              {message.role === 'assistant' && message.proposals?.length ? (
                <View style={styles.proposalList}>
                  {message.proposals.map((proposal) => (
                    <ToolProposalCard
                      key={proposal.id}
                      proposal={proposal}
                      onApply={() => applyProposal(message.id, proposal)}
                    />
                  ))}
                </View>
              ) : null}
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
          <View style={styles.composerWrap}>
            <Pressable accessibilityRole="button" accessibilityLabel="Edit meal context" onPress={() => setContextOpen(true)} style={styles.plus}><Text style={styles.plusText}>＋</Text></Pressable>
            {Platform.OS === 'web' && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={dictationActive ? 'Stop dictation' : 'Start dictation'}
                accessibilityHint={dictationEngine === 'whisper'
                  ? 'Uses the downloaded Whisper model. Change dictation engine in Settings.'
                  : 'Uses browser on-device speech. Change dictation engine in Settings.'}
                accessibilityState={{ disabled: dictationStatus === 'stopping' }}
                disabled={dictationStatus === 'stopping'}
                onPress={dictationActive ? stopDictation : startDictation}
                style={[
                  styles.dictationIconButton,
                  dictationActive && styles.dictationIconButtonActive,
                  dictationStatus === 'stopping' && styles.dictationIconButtonDisabled
                ]}
              >
                <View style={styles.micGlyph}>
                  <View style={[styles.micBody, dictationActive && styles.micStrokeActive]} />
                  <View style={[styles.micArc, dictationActive && styles.micStrokeActive]} />
                  <View style={[styles.micStem, dictationActive && styles.micFillActive]} />
                  <View style={[styles.micBase, dictationActive && styles.micFillActive]} />
                </View>
              </Pressable>
            )}
            <TextInput
              accessibilityLabel="Message Chef"
              accessibilityHint={dictationActive ? 'Press Stop dictation to edit the transcript.' : undefined}
              editable={!dictationActive}
              value={input}
              onChangeText={setInput}
              placeholder="Type or dictate to Chef…"
              placeholderTextColor={themeColor('#94a3b8')}
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

      <ConversationHistoryModal
        visible={historyOpen}
        conversations={app.chatHistory}
        onClose={() => setHistoryOpen(false)}
        onOpen={openConversation}
        onDelete={app.deleteChatConversation}
      />

      <Modal
        transparent
        animationType="fade"
        visible={Boolean(dictationDialog)}
        onRequestClose={() => setDictationDialog(null)}
      >
        <View style={styles.dictationDialogBackdrop}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss dictation message"
            onPress={() => setDictationDialog(null)}
            style={styles.dictationDialogDismissArea}
          />
          <View accessibilityLiveRegion="assertive" style={styles.dictationDialogCard}>
            <Text style={styles.dictationDialogTitle}>{dictationDialog?.title}</Text>
            <Text style={styles.dictationDialogMessage}>{dictationDialog?.message}</Text>
            <View style={styles.dictationDialogActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close dictation message"
                onPress={() => setDictationDialog(null)}
                style={styles.dictationDialogSecondary}
              >
                <Text style={styles.dictationDialogSecondaryText}>Not now</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open dictation settings"
                onPress={() => {
                  setDictationDialog(null);
                  router.push('/settings?focus=dictation');
                }}
                style={styles.dictationDialogPrimary}
              >
                <Text style={styles.dictationDialogPrimaryText}>Dictation settings</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, fontWeight: '800', color: '#94a3b8' },
  title: { fontSize: 34, lineHeight: 39, fontWeight: '800', color: '#172033' },
  headerActions: { flexDirection: 'row', gap: 8 },
  historyButton: { height: 42, borderRadius: 21, backgroundColor: '#f1f5f9', paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  historyText: { fontSize: 13, color: '#475569', fontWeight: '700' },
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
  messageGroup: { width: '100%', gap: 8 },
  proposalList: { gap: 8 },
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
  composerWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingBottom: 10, backgroundColor: 'white', flexWrap: 'wrap' },
  plus: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  plusText: { fontSize: 24, color: '#475569' },
  dictationIconButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  dictationIconButtonActive: { backgroundColor: '#fee2e2' },
  dictationIconButtonDisabled: { opacity: 0.55 },
  micGlyph: { width: 20, height: 22, position: 'relative' },
  micBody: { position: 'absolute', left: 6, top: 1, width: 8, height: 13, borderWidth: 2, borderColor: '#475569', borderRadius: 6 },
  micArc: { position: 'absolute', left: 3, top: 8, width: 14, height: 9, borderLeftWidth: 2, borderRightWidth: 2, borderBottomWidth: 2, borderColor: '#475569', borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
  micStem: { position: 'absolute', left: 9, top: 16, width: 2, height: 4, borderRadius: 1, backgroundColor: '#475569' },
  micBase: { position: 'absolute', left: 5, top: 20, width: 10, height: 2, borderRadius: 1, backgroundColor: '#475569' },
  micStrokeActive: { borderColor: '#b91c1c' },
  micFillActive: { backgroundColor: '#b91c1c' },
  composer: { flex: 1, minWidth: 140, maxHeight: 160, minHeight: 42, borderRadius: 18, backgroundColor: '#f1f5f9', paddingHorizontal: 14, paddingVertical: 10, color: '#172033', fontSize: 15.5 },
  composerDictating: { backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0' },
  send: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#172033', alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.35 },
  sendGlyph: { width: 18, height: 20, position: 'relative' },
  sendShaft: { position: 'absolute', left: 8, top: 4, bottom: 2, width: 2, borderRadius: 1, backgroundColor: 'white' },
  sendHeadLeft: { position: 'absolute', left: 3, top: 4, width: 8, height: 2, borderRadius: 1, backgroundColor: 'white', transform: [{ rotate: '-45deg' }] },
  sendHeadRight: { position: 'absolute', right: 3, top: 4, width: 8, height: 2, borderRadius: 1, backgroundColor: 'white', transform: [{ rotate: '45deg' }] },
  stopGlyph: { width: 11, height: 11, borderRadius: 2, backgroundColor: 'white' },
  dictationDialogBackdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.35)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  dictationDialogDismissArea: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  dictationDialogCard: { width: '100%', maxWidth: 420, borderRadius: 20, backgroundColor: 'white', padding: 18, gap: 10, borderWidth: 1, borderColor: '#e2e8f0' },
  dictationDialogTitle: { color: '#172033', fontSize: 18, fontWeight: '800' },
  dictationDialogMessage: { color: '#475569', fontSize: 14, lineHeight: 20 },
  dictationDialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  dictationDialogSecondary: { minHeight: 42, borderRadius: 12, backgroundColor: '#f1f5f9', paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  dictationDialogSecondaryText: { color: '#475569', fontWeight: '700' },
  dictationDialogPrimary: { minHeight: 42, borderRadius: 12, backgroundColor: '#172033', paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  dictationDialogPrimaryText: { color: 'white', fontWeight: '800' }
});
