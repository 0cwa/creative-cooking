import {useAppTheme} from '@/theme/theme';
import { useRef, useState } from 'react';
import { FlatList, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, themeColor } from '@/theme/StyleSheet';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { SettingsGlyph } from '@/components/SettingsGlyph';
import { PantryRow } from '@/components/PantryRow';
import { normalizeIngredientName } from '@/domain/pantry';
import { useAppState } from '@/state/AppState';

// Android uses the platform list while retaining the same row controls.
const PantryList = Platform.OS === 'android' ? FlatList : FlashList;

export default function PantryScreen() {
  useAppTheme();
  const router = useRouter();
  const {
    pantry, shopping, addPantryItems, removePantryItem, setPantryPreference, buyAgainPantryItem,
    contentWorkspaceName, localPersistenceStatus, canEditSharedContent
  } = useAppState();
  const [notice, setNotice] = useState('');
  const toBuy = shopping.items.filter((item) => {
    const list = shopping.lists.find((candidate) => candidate.id === item.listId);
    return list && !list.removedAt && !item.removedAt && item.purchaseCycleId === list.currentCycleId
      && item.purchasedCycleId !== list.currentCycleId && !item.checked;
  }).length;
  const buyAgain = (id: string, name: string) => {
    const moved = buyAgainPantryItem(id);
    if (moved) setNotice(moved.alreadyListed ? `${name} was already on ${moved.listName}.` : `${name} moved to ${moved.listName}.`);
  };
  const readOnly = !canEditSharedContent;
  const [input, setInput] = useState('');
  const inputRef = useRef<TextInput>(null);

  const add = () => {
    if (readOnly) return;
    const name = normalizeIngredientName(input);
    if (!name) return;
    addPantryItems([name], 3);
    setInput('');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <Screen testID="pantry-screen">
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>YOUR KITCHEN</Text>
          <Text style={styles.title}>Pantry</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable accessibilityRole="button" accessibilityLabel={toBuy ? `Open Shopping, ${toBuy} to buy` : 'Open Shopping'} onPress={() => router.push('/shopping')} style={styles.shoppingButton}>
            <Text style={styles.shoppingButtonText}>Shopping{toBuy ? ` · ${toBuy}` : ''}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => router.push('/settings')} style={styles.settingsButton}>
            <SettingsGlyph />
          </Pressable>
        </View>
      </View>

      <View style={styles.workspaceStatusWrap}>
        <Text testID="pantry-workspace-status" style={styles.workspaceStatus}>
          Cooking in {contentWorkspaceName}
        </Text>
        <Text testID="pantry-local-persistence-status" accessibilityLiveRegion="polite" style={styles.localPersistenceStatus}>
          {localPersistenceStatus === 'saving' ? 'Saving locally' : localPersistenceStatus === 'error' ? 'Local save failed' : 'Saved locally'}
        </Text>
        {notice ? <Text testID="pantry-notice" accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
      </View>

      <View style={styles.listWrap}>
        <PantryList
          data={pantry}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <PantryRow
              item={item}
              onDelete={() => removePantryItem(item.id)}
              onBuyAgain={readOnly ? undefined : () => buyAgain(item.id, item.name)}
              onPreference={(preference) => setPantryPreference(item.id, preference)}
            />
          )}
          ListHeaderComponent={pantry.length > 0 ? (
            <View style={styles.nextStep}>
              <Text style={styles.preferenceHelp}>Stars are your appetite: 1 = not today, 5 = love to eat it.</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push('/recipes')} style={styles.browseButton}>
                <Text style={styles.browseButtonText}>Browse recipe ideas</Text>
              </Pressable>
            </View>
          ) : null}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>🧺</Text>
              <Text style={styles.emptyTitle}>What’s in the kitchen?</Text>
              <Text style={styles.emptyText}>
                {readOnly
                  ? 'No ingredients have been added here yet. You can still browse recipe ideas.'
                  : 'Start with a few ingredients you have. A name is enough — no quantities or full kitchen inventory needed.'}
              </Text>
              {!readOnly && <>
                <Pressable accessibilityRole="button" accessibilityHint="Moves to the ingredient box below." onPress={() => inputRef.current?.focus()} style={styles.firstIngredientButton}>
                  <Text style={styles.addButtonText}>Add your first ingredient</Text>
                </Pressable>
                <Text style={styles.exampleHelp}>Try an example in the box, then add it if you have it.</Text>
                <View style={styles.examples}>
                  {['rice', 'eggs', 'peas (frozen)'].map((name) => (
                    <Pressable key={name} accessibilityRole="button" accessibilityLabel={`Use example ${name}`} onPress={() => { setInput(name); inputRef.current?.focus(); }} style={styles.exampleButton}>
                      <Text style={styles.exampleText}>{name}</Text>
                    </Pressable>
                  ))}
                </View>
              </>}
              <Pressable accessibilityRole="button" onPress={() => router.push('/recipes')} style={styles.browseButton}>
                <Text style={styles.browseButtonText}>Browse recipe ideas</Text>
              </Pressable>
              <Text style={styles.exampleHelp}>You can explore recipes before filling your pantry.</Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: 16 }}
        />
      </View>

      <View testID="pantry-composer" style={styles.composer}>
        <Text style={styles.composerHelp}>
          {readOnly
            ? 'This household is read-only for viewers. Choose an editor workspace to change pantry records.'
            : 'Add one ingredient at a time. Details like “mint (dried)” are optional.'}
        </Text>
        <View style={styles.composerRow}>
          <TextInput
            ref={inputRef}
            accessibilityLabel="Ingredient and details"
            value={input}
            onChangeText={setInput}
            onSubmitEditing={add}
            editable={!readOnly}
            placeholder="e.g. tomatoes"
            placeholderTextColor={themeColor('#94a3b8')}
            returnKeyType="done"
            submitBehavior="submit"
            style={[styles.input, readOnly && styles.inputReadOnly]}
            multiline={false}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Add ingredient" accessibilityState={{ disabled: readOnly || !input.trim() }} disabled={readOnly || !input.trim()} onPress={add} style={[styles.addButton, (readOnly || !input.trim()) && styles.addButtonDisabled]}>
            <Text style={styles.addButtonText}>Add</Text>
          </Pressable>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, fontWeight: '800', color: '#94a3b8' },
  title: { fontSize: 34, lineHeight: 39, fontWeight: '800', color: '#172033' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shoppingButton: { minHeight: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  shoppingButtonText: { color: '#172033', fontWeight: '700' },
  notice: { color: '#334155', fontSize: 12.5, fontWeight: '600' },
  settingsButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  workspaceStatusWrap: { paddingHorizontal: 20, paddingBottom: 6, gap: 2 },
  workspaceStatus: { color: '#64748b', fontSize: 12, fontWeight: '700' },
  localPersistenceStatus: { color: '#64748b', fontSize: 11.5 },
  listWrap: { flex: 1 },
  nextStep: { paddingHorizontal: 20, paddingVertical: 10, gap: 8, alignItems: 'flex-start' },
  preferenceHelp: { color: '#64748b', fontSize: 13, lineHeight: 19 },
  browseButton: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 13, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  browseButtonText: { color: '#172033', fontWeight: '700', textAlign: 'center' },
  firstIngredientButton: { minHeight: 44, paddingHorizontal: 18, paddingVertical: 12, marginTop: 18, borderRadius: 13, backgroundColor: '#172033', alignItems: 'center', justifyContent: 'center' },
  exampleHelp: { color: '#64748b', fontSize: 12.5, lineHeight: 18, textAlign: 'center', marginTop: 10 },
  examples: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 8, marginBottom: 20 },
  exampleButton: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 22, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: 'white', justifyContent: 'center' },
  exampleText: { color: '#475569', fontSize: 14 },
  composer: { borderTopWidth: 1, borderTopColor: '#e2e8f0', backgroundColor: 'white', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12, gap: 8 },
  composerHelp: { color: '#64748b', fontSize: 12.5, lineHeight: 17, textAlign: 'center' },
  composerRow: { flexDirection: 'row', gap: 9, alignItems: 'center', flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 160, minHeight: 44, borderRadius: 13, backgroundColor: '#f1f5f9', color: '#172033', paddingHorizontal: 13, paddingVertical: 10, fontSize: 16 },
  inputReadOnly: { opacity: 0.65 },
  addButton: { minWidth: 68, minHeight: 44, backgroundColor: '#172033', borderRadius: 13, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  addButtonDisabled: { opacity: 0.4 },
  addButtonText: { color: 'white', fontWeight: '700', textAlign: 'center' },
  empty: { width: '100%', maxWidth: 460, alignSelf: 'center', alignItems: 'center', paddingHorizontal: 24, paddingTop: 24, paddingBottom: 18 },
  emptyEmoji: { fontSize: 44 },
  emptyTitle: { marginTop: 14, fontSize: 20, fontWeight: '700', color: '#334155', textAlign: 'center' },
  emptyText: { marginTop: 8, color: '#64748b', textAlign: 'center', lineHeight: 21 }
});
