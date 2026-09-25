import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { SettingsGlyph } from '@/components/SettingsGlyph';
import { normalizeIngredientName } from '@/domain/pantry';
import { useAppState } from '@/state/AppState';

export default function ShoppingScreen() {
  const router = useRouter();
  const {
    shoppingList,
    addShoppingItems,
    removeShoppingItem,
    toggleShoppingItem,
    moveCheckedShoppingToPantry
  } = useAppState();
  const [input, setInput] = useState('');
  const inputRef = useRef<TextInput>(null);

  const checkedCount = shoppingList.filter((item) => item.checked).length;
  const remainingCount = shoppingList.length - checkedCount;
  const rows = [...shoppingList].sort((a, b) => Number(a.checked) - Number(b.checked));

  const add = () => {
    const name = normalizeIngredientName(input);
    if (!name) return;
    addShoppingItems([{ name }]);
    setInput('');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <Screen>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>PLAN AHEAD</Text>
          <Text style={styles.title}>Shopping</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => router.push('/settings')} style={styles.settingsButton}>
          <SettingsGlyph />
        </Pressable>
      </View>

      {!!shoppingList.length && (
        <View style={styles.summaryCard}>
          <View style={styles.summaryIcon}><Text accessible={false} style={styles.summaryIconText}>🛒</Text></View>
          <View style={styles.summaryText}>
            <Text style={styles.summaryTitle}>{remainingCount ? `${remainingCount} to pick up` : 'Everything is checked off'}</Text>
            <Text style={styles.summaryHelp}>Check things off while you shop. Purchased items can move straight into Pantry.</Text>
          </View>
        </View>
      )}

      <View style={styles.listWrap}>
        <FlashList
          data={rows}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View style={[styles.row, item.checked && styles.rowChecked]}>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: item.checked }}
                accessibilityLabel={`${item.name} purchased`}
                onPress={() => toggleShoppingItem(item.id)}
                style={styles.checkTarget}
              >
                <View style={[styles.checkbox, item.checked && styles.checkboxChecked]}>
                  <Text accessible={false} style={styles.checkboxText}>{item.checked ? '✓' : ''}</Text>
                </View>
                <View style={styles.itemText}>
                  <Text style={[styles.itemName, item.checked && styles.itemNameChecked]}>
                    {item.amount ? `${item.amount} ` : ''}{item.name}
                  </Text>
                  <Text style={styles.itemHint}>{item.checked ? 'Ready for Pantry' : 'Tap when it is in your basket'}</Text>
                </View>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item.name} from Shopping`}
                onPress={() => removeShoppingItem(item.id)}
                style={styles.removeButton}
              >
                <Text style={styles.removeText}>×</Text>
              </Pressable>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>🛒</Text>
              <Text style={styles.emptyTitle}>Your shopping list is clear</Text>
              <Text style={styles.emptyText}>Add something below, send missing recipe ingredients here, or use Buy again on a Pantry item when you want to restock it.</Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: 18 }}
        />
      </View>

      {!!checkedCount && (
        <View style={styles.purchasedBar}>
          <View style={styles.purchasedTextWrap}>
            <Text style={styles.purchasedTitle}>{checkedCount === 1 ? '1 item purchased' : `${checkedCount} items purchased`}</Text>
            <Text style={styles.purchasedHelp}>Move checked items into Pantry and remove them from this list.</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Put checked items in Pantry"
            onPress={moveCheckedShoppingToPantry}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Put in Pantry</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.composer}>
        <Text style={styles.composerHelp}>Add anything else you want to pick up.</Text>
        <View style={styles.composerRow}>
          <TextInput
            ref={inputRef}
            accessibilityLabel="Shopping item"
            value={input}
            onChangeText={setInput}
            onSubmitEditing={add}
            placeholder="e.g. lemons"
            placeholderTextColor="#94a3b8"
            returnKeyType="done"
            submitBehavior="submit"
            style={styles.input}
            multiline={false}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add shopping item"
            accessibilityState={{ disabled: !input.trim() }}
            disabled={!input.trim()}
            onPress={add}
            style={[styles.addButton, !input.trim() && styles.addButtonDisabled]}
          >
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
  summaryCard: { marginHorizontal: 16, marginBottom: 8, padding: 14, borderRadius: 18, backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0', flexDirection: 'row', alignItems: 'center', gap: 12 },
  summaryIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' },
  summaryIconText: { fontSize: 21 },
  summaryText: { flex: 1 },
  summaryTitle: { color: '#166534', fontWeight: '800', fontSize: 15 },
  summaryHelp: { color: '#3f6212', marginTop: 3, fontSize: 12.5, lineHeight: 17 },
  listWrap: { flex: 1 },
  row: { marginHorizontal: 16, marginVertical: 5, minHeight: 70, borderRadius: 16, backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#e2e8f0', flexDirection: 'row', alignItems: 'center' },
  rowChecked: { backgroundColor: '#f8fafc' },
  checkTarget: { flex: 1, minHeight: 68, paddingLeft: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  checkbox: { width: 26, height: 26, borderRadius: 8, borderWidth: 2, borderColor: '#cbd5e1', alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff' },
  checkboxChecked: { borderColor: '#16a34a', backgroundColor: '#16a34a' },
  checkboxText: { color: '#ffffff', fontSize: 16, fontWeight: '900', lineHeight: 18 },
  itemText: { flex: 1 },
  itemName: { color: '#172033', fontSize: 17, fontWeight: '600' },
  itemNameChecked: { color: '#64748b', textDecorationLine: 'line-through' },
  itemHint: { color: '#94a3b8', fontSize: 11.5, marginTop: 4 },
  removeButton: { width: 48, height: 52, marginRight: 4, alignItems: 'center', justifyContent: 'center' },
  removeText: { fontSize: 28, color: '#94a3b8', lineHeight: 30 },
  empty: { alignItems: 'center', paddingHorizontal: 38, paddingTop: 62 },
  emptyEmoji: { fontSize: 44 },
  emptyTitle: { marginTop: 14, fontSize: 20, fontWeight: '700', color: '#334155', textAlign: 'center' },
  emptyText: { marginTop: 8, color: '#64748b', textAlign: 'center', lineHeight: 21, maxWidth: 420 },
  purchasedBar: { borderTopWidth: 1, borderTopColor: '#dcfce7', backgroundColor: '#f0fdf4', paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  purchasedTextWrap: { flex: 1, minWidth: 190 },
  purchasedTitle: { color: '#166534', fontWeight: '800' },
  purchasedHelp: { color: '#4d7c0f', fontSize: 12, lineHeight: 16, marginTop: 2 },
  primaryButton: { minHeight: 44, borderRadius: 13, backgroundColor: '#166534', paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#ffffff', fontWeight: '800' },
  composer: { borderTopWidth: 1, borderTopColor: '#e2e8f0', backgroundColor: 'white', paddingHorizontal: 14, paddingTop: 9, paddingBottom: 12, gap: 7 },
  composerHelp: { color: '#64748b', fontSize: 12.5, lineHeight: 17, textAlign: 'center' },
  composerRow: { flexDirection: 'row', gap: 9, alignItems: 'center', flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 160, minHeight: 44, borderRadius: 13, backgroundColor: '#f1f5f9', color: '#172033', paddingHorizontal: 13, paddingVertical: 10, fontSize: 16 },
  addButton: { minWidth: 68, minHeight: 44, backgroundColor: '#172033', borderRadius: 13, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  addButtonDisabled: { opacity: 0.4 },
  addButtonText: { color: 'white', fontWeight: '700', textAlign: 'center' }
});
