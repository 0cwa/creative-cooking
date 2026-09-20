import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { PantryRow } from '@/components/PantryRow';
import { parseIngredientInput } from '@/domain/pantry';
import { useAppState } from '@/state/AppState';

export default function PantryScreen() {
  const router = useRouter();
  const { pantry, addPantryItems, removePantryItem, setPantryPreference } = useAppState();
  const [input, setInput] = useState('');

  const add = () => {
    const names = parseIngredientInput(input);
    if (!names.length) return;
    addPantryItems(names, 3);
    setInput('');
  };

  return (
    <Screen>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>YOUR KITCHEN</Text>
          <Text style={styles.title}>Pantry</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => router.push('/settings')} style={styles.settingsButton}>
          <Text style={styles.settingsIcon}>⚙</Text>
        </Pressable>
      </View>

      <View style={styles.addCard}>
        <TextInput
          value={input}
          onChangeText={setInput}
          onSubmitEditing={add}
          placeholder="Type or dictate: onions, leeks, carrots…"
          placeholderTextColor="#94a3b8"
          returnKeyType="done"
          style={styles.input}
          multiline
        />
        <Pressable onPress={add} style={styles.addButton}><Text style={styles.addButtonText}>Add</Text></Pressable>
      </View>
      <Text style={styles.hint}>Names are enough. New ingredients start at ★★★ (open to eating).</Text>

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
            <Text style={styles.emptyText}>Add ingredients above. You can paste a comma-separated list and refine preferences later.</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 28 }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, fontWeight: '800', color: '#94a3b8' },
  title: { fontSize: 34, lineHeight: 39, fontWeight: '800', color: '#172033' },
  settingsButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  settingsIcon: { fontSize: 21 },
  addCard: { marginHorizontal: 16, flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: 'white', padding: 10, borderRadius: 18, borderWidth: 1, borderColor: '#e2e8f0' },
  input: { flex: 1, minHeight: 44, maxHeight: 90, color: '#172033', paddingHorizontal: 8, fontSize: 16 },
  addButton: { backgroundColor: '#172033', borderRadius: 13, paddingHorizontal: 18, paddingVertical: 13 },
  addButtonText: { color: 'white', fontWeight: '750' },
  hint: { color: '#64748b', fontSize: 12, marginHorizontal: 20, marginTop: 8, marginBottom: 5 },
  empty: { alignItems: 'center', paddingHorizontal: 38, paddingTop: 64 },
  emptyEmoji: { fontSize: 44 },
  emptyTitle: { marginTop: 14, fontSize: 20, fontWeight: '750', color: '#334155' },
  emptyText: { marginTop: 8, color: '#64748b', textAlign: 'center', lineHeight: 21 }
});
