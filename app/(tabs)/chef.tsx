import { useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { MealContextModal } from '@/components/MealContextModal';
import { buildChefSystemPrompt } from '@/chef/context';
import type { IngredientPreference, UiQuestion } from '@/domain/types';
import { openRouterProvider } from '@/llm/openrouter/provider';
import { getOpenRouterKey } from '@/storage/credentialVault';
import { makeChatMessage, useAppState } from '@/state/AppState';

export default function ChefScreen() {
  const router = useRouter();
  const app = useAppState();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [question, setQuestion] = useState<UiQuestion | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const stateSnapshot = useMemo(() => ({
    pantry: app.pantry,
    recipes: app.recipes,
    chatMessages: app.chatMessages,
    mealContext: app.mealContext,
    settings: app.settings
  }), [app.pantry, app.recipes, app.chatMessages, app.mealContext, app.settings]);

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || busy) return;
    setInput('');
    setQuestion(null);
    const userMessage = makeChatMessage('user', text);
    const messages = [...app.chatMessages, userMessage];
    app.appendChatMessage(userMessage);
    setBusy(true);

    try {
      const apiKey = await getOpenRouterKey();
      if (!apiKey) {
        app.appendChatMessage(makeChatMessage('assistant', 'Connect OpenRouter or paste an API key in Settings, then I can cook with you.'));
        return;
      }

      const result = await openRouterProvider.run({
        apiKey,
        model: app.settings.model,
        systemPrompt: buildChefSystemPrompt({ ...stateSnapshot, chatMessages: messages }),
        messages,
        tools: {
          addPantry: (names, preference: IngredientPreference = 3) => app.addPantryItems(names, preference),
          removePantry: app.removePantryByName,
          setPantryPreference: app.setPantryPreferenceByName,
          saveRecipe: app.saveRecipe
        }
      });

      if (result.text.trim()) app.appendChatMessage(makeChatMessage('assistant', result.text.trim()));
      if (result.question) setQuestion(result.question);
    } catch (error) {
      app.appendChatMessage(makeChatMessage('assistant', `I hit a provider error: ${error instanceof Error ? error.message : 'Unknown error'}`));
    } finally {
      setBusy(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    }
  };

  const reset = () => {
    Alert.alert('Start a new chat?', 'Your pantry and saved recipes stay as they are.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'New chat', style: 'destructive', onPress: () => { app.newChat(); setQuestion(null); } }
    ]);
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>CREATIVE COOKING</Text>
            <Text style={styles.title}>Chef</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable onPress={reset} style={styles.iconButton}><Text style={styles.iconText}>＋</Text></Pressable>
            <Pressable onPress={() => router.push('/settings')} style={styles.iconButton}><Text style={styles.iconText}>⚙</Text></Pressable>
          </View>
        </View>

        <View style={styles.contextStrip}>
          <Pressable
            onPress={() => app.updateMealContext({ willingToShop: !app.mealContext.willingToShop })}
            style={[styles.contextChip, app.mealContext.willingToShop && styles.contextChipActive]}
          >
            <Text style={[styles.contextChipText, app.mealContext.willingToShop && styles.contextChipTextActive]}>🛒 {app.mealContext.willingToShop ? 'Can shop' : 'Pantry only'}</Text>
          </Pressable>
          <Pressable onPress={() => setContextOpen(true)} style={styles.contextChip}>
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
          {busy && <View style={[styles.bubble, styles.chefBubble]}><Text style={styles.typing}>Chef is thinking…</Text></View>}
          {question && (
            <View style={styles.questionCard}>
              <Text style={styles.questionTitle}>{question.prompt}</Text>
              <View style={styles.questionOptions}>
                {question.options.map((option) => (
                  <Pressable key={option} onPress={() => void send(`For your question “${question.prompt}”, I choose: ${option}`)} style={styles.questionOption}>
                    <Text style={styles.questionOptionText}>{option}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </ScrollView>

        <View style={styles.composerWrap}>
          <Pressable onPress={() => setContextOpen(true)} style={styles.plus}><Text style={styles.plusText}>＋</Text></Pressable>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Type or dictate to Chef…"
            placeholderTextColor="#94a3b8"
            style={styles.composer}
            multiline
            onSubmitEditing={() => void send()}
          />
          <Pressable disabled={!input.trim() || busy} onPress={() => void send()} style={[styles.send, (!input.trim() || busy) && styles.sendDisabled]}>
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
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
  iconButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 20, color: '#334155' },
  contextStrip: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8, flexWrap: 'wrap' },
  contextChip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#e2e8f0' },
  contextChipActive: { backgroundColor: '#14532d' },
  contextChipText: { color: '#475569', fontSize: 13, fontWeight: '600' },
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
  questionCard: { backgroundColor: '#fff7ed', borderColor: '#fed7aa', borderWidth: 1, borderRadius: 18, padding: 15, gap: 12 },
  questionTitle: { color: '#7c2d12', fontWeight: '700', fontSize: 16 },
  questionOptions: { gap: 8 },
  questionOption: { backgroundColor: 'white', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#fed7aa' },
  questionOptionText: { color: '#9a3412', fontWeight: '600' },
  composerWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#e2e8f0', backgroundColor: 'white' },
  plus: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  plusText: { fontSize: 24, color: '#475569' },
  composer: { flex: 1, maxHeight: 120, minHeight: 42, borderRadius: 18, backgroundColor: '#f1f5f9', paddingHorizontal: 14, paddingVertical: 10, color: '#172033', fontSize: 15.5 },
  send: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#172033', alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.35 },
  sendText: { color: 'white', fontSize: 22, fontWeight: '800' }
});
