import { useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, themeColor } from '@/theme/StyleSheet';
import { useSystemColorScheme } from '@/theme/theme';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { SettingsGlyph } from '@/components/SettingsGlyph';
import { PantryRow } from '@/components/PantryRow';
import { normalizeIngredientName } from '@/domain/pantry';
import { useAppState } from '@/state/AppState';

export default function PantryScreen() {
  useSystemColorScheme();
  const router = useRouter();
  const { pantry, addPantryItems, removePantryItem, setPantryPreference } = useAppState();
  const [input, setInput] = useState('');
  const inputRef = useRef<TextInput>(null);

  const add = () => {
    const name = normalizeIngredientName(input);
    if (!name) return;
    addPantryItems([name], 3);
    setInput('');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <Screen>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>YOUR KITCHEN</Text>
          <Text style={styles.title}>Pantry</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => router.push('/settings')} style={styles.settingsButton}>
          <SettingsGlyph />
        </Pressable>
      </View>

      <View style={styles.listWrap}>
        <FlashList
          data={pantry}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <PantryRow
              item={item}
              onDelete={() => removePantryItem(item.id)}
              onPreference={(preference) => setPantryPreference(item.id, preference)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>🧺</Text>
              <Text style={styles.emptyTitle}>What’s in the kitchen?</Text>
              <Text style={styles.emptyText}>Add ingredients one at a time below, or tell Chef everything you have in one message.</Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: 16 }}
        />
      </View>

      <View testID="pantry-composer" style={styles.composer}>
        <Text style={styles.composerHelp}>Add an ingredient with any useful detail — for example mint (dried) or okra (frozen). To dictate many at once, tell Chef.</Text>
        <View style={styles.composerRow}>
          <TextInput
            ref={inputRef}
            accessibilityLabel="Ingredient and details"
            value={input}
            onChangeText={setInput}
            onSubmitEditing={add}
            placeholder="e.g. mint (dried)"
            placeholderTextColor={themeColor('#94a3b8')}
            returnKeyType="done"
            submitBehavior="submit"
            style={styles.input}
            multiline={false}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Add ingredient" accessibilityState={{ disabled: !input.trim() }} disabled={!input.trim()} onPress={add} style={[styles.addButton, !input.trim() && styles.addButtonDisabled]}>
            <Text style={styles.addButtonText}>Add</Text>
          </Pressable>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, fontWeight: '800', color: '#94a3b8' },
  title: { fontSize: 34, lineHeight: 39, fontWeight: '800', color: '#172033' },
  settingsButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  listWrap: { flex: 1 },
  composer: { borderTopWidth: 1, borderTopColor: '#e2e8f0', backgroundColor: 'white', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12, gap: 8 },
  composerHelp: { color: '#64748b', fontSize: 12.5, lineHeight: 17, textAlign: 'center' },
  composerRow: { flexDirection: 'row', gap: 9, alignItems: 'center', flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 160, minHeight: 44, borderRadius: 13, backgroundColor: '#f1f5f9', color: '#172033', paddingHorizontal: 13, paddingVertical: 10, fontSize: 16 },
  addButton: { minWidth: 68, minHeight: 44, backgroundColor: '#172033', borderRadius: 13, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  addButtonDisabled: { opacity: 0.4 },
  addButtonText: { color: 'white', fontWeight: '700', textAlign: 'center' },
  empty: { alignItems: 'center', paddingHorizontal: 38, paddingTop: 64 },
  emptyEmoji: { fontSize: 44 },
  emptyTitle: { marginTop: 14, fontSize: 20, fontWeight: '700', color: '#334155', textAlign: 'center' },
  emptyText: { marginTop: 8, color: '#64748b', textAlign: 'center', lineHeight: 21 }
});
