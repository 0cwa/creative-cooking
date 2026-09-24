import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { SettingsGlyph } from '@/components/SettingsGlyph';
import {
  formatRecipeIngredientsText,
  formatRecipeTextList,
  parseRecipeIngredientsText,
  parseRecipeTextList,
  scaleRecipeIngredients,
  shoppingIngredients
} from '@/domain/recipeEditing';
import type { Recipe } from '@/domain/types';
import { useAppState } from '@/state/AppState';

type RecipeDraft = Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;

type RecipeEditDraft = {
  title: string;
  description: string;
  ingredientsText: string;
  stepsText: string;
  notesText: string;
};

function toRecipeDraft(recipe: Recipe): RecipeDraft {
  return {
    title: recipe.title,
    description: recipe.description,
    portions: recipe.portions,
    ingredients: recipe.ingredients.map((ingredient) => ({ ...ingredient })),
    steps: [...recipe.steps],
    notes: recipe.notes ? [...recipe.notes] : undefined
  };
}

function toRecipeEditDraft(recipe: Recipe): RecipeEditDraft {
  return {
    title: recipe.title,
    description: recipe.description ?? '',
    ingredientsText: formatRecipeIngredientsText(recipe.ingredients),
    stepsText: formatRecipeTextList(recipe.steps),
    notesText: formatRecipeTextList(recipe.notes)
  };
}

function cleanRecipeEditDraft(recipe: Recipe, draft: RecipeEditDraft): RecipeDraft {
  const notes = parseRecipeTextList(draft.notesText);

  return {
    title: draft.title.trim(),
    description: draft.description.trim() || undefined,
    portions: recipe.portions,
    ingredients: parseRecipeIngredientsText(draft.ingredientsText, recipe.ingredients),
    steps: parseRecipeTextList(draft.stepsText),
    notes: notes.length ? notes : undefined
  };
}

export default function RecipesScreen() {
  const router = useRouter();
  const {
    pantry,
    recipes,
    addPantryItems,
    updateRecipe,
    deleteRecipe
  } = useAppState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RecipeEditDraft | null>(null);
  const [checkedShopping, setCheckedShopping] = useState<Set<number>>(new Set());

  const selected = recipes.find((recipe) => recipe.id === selectedId) ?? null;
  const shoppingRows = selected
    ? (() => {
        const shopping = new Set(shoppingIngredients(selected.ingredients, pantry.map((item) => item.name)));
        return selected.ingredients
          .map((ingredient, index) => ({ ingredient, index }))
          .filter(({ ingredient }) => shopping.has(ingredient));
      })()
    : [];

  const openRecipe = (recipe: Recipe) => {
    setSelectedId(recipe.id);
    setDraft(null);
    setCheckedShopping(new Set());
  };

  const closeRecipe = () => {
    setSelectedId(null);
    setDraft(null);
    setCheckedShopping(new Set());
  };

  const startEditing = () => {
    if (!selected) return;
    setCheckedShopping(new Set());
    setDraft(toRecipeEditDraft(selected));
  };

  const saveEditing = () => {
    if (!selected || !draft) return;
    const cleaned = cleanRecipeEditDraft(selected, draft);

    if (!cleaned.title) {
      Alert.alert('Recipe needs a title', 'Add a title before saving.');
      return;
    }
    if (!cleaned.ingredients.length) {
      Alert.alert('Recipe needs ingredients', 'Keep at least one ingredient before saving.');
      return;
    }
    if (!cleaned.steps.length) {
      Alert.alert('Recipe needs a method', 'Keep at least one cooking step before saving.');
      return;
    }

    try {
      updateRecipe(selected.id, cleaned);
      setCheckedShopping(new Set());
      setDraft(null);
    } catch (error) {
      Alert.alert('Could not save recipe', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const scalePortions = (nextPortions: number) => {
    if (!selected || nextPortions < 1 || nextPortions === selected.portions) return;

    try {
      updateRecipe(selected.id, {
        ...toRecipeDraft(selected),
        portions: nextPortions,
        ingredients: scaleRecipeIngredients(selected.ingredients, selected.portions, nextPortions)
      });
    } catch (error) {
      Alert.alert('Could not scale recipe', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const toggleShoppingItem = (index: number) => {
    setCheckedShopping((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const addCheckedToPantry = () => {
    if (!selected || !checkedShopping.size) return;

    const purchasedNames = selected.ingredients
      .filter((_, index) => checkedShopping.has(index))
      .map((ingredient) => ingredient.name);

    try {
      updateRecipe(selected.id, {
        ...toRecipeDraft(selected),
        ingredients: selected.ingredients.map((ingredient, index) => (
          checkedShopping.has(index)
            ? { ...ingredient, needsShopping: undefined }
            : ingredient
        ))
      });
      addPantryItems(purchasedNames);
      setCheckedShopping(new Set());
      Alert.alert(
        'Pantry updated',
        purchasedNames.length === 1
          ? `${purchasedNames[0]} was added to Pantry.`
          : `${purchasedNames.length} ingredients were added to Pantry.`
      );
    } catch (error) {
      Alert.alert('Could not update shopping list', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <View><Text style={styles.eyebrow}>YOUR COOKBOOK</Text><Text style={styles.title}>Saved recipes</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => router.push('/settings')} style={styles.settings}><SettingsGlyph /></Pressable>
      </View>

      <FlashList
        data={recipes}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`Open recipe ${item.title}`} onPress={() => openRecipe(item)} style={styles.card}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              {!!item.description && <Text numberOfLines={2} style={styles.cardDescription}>{item.description}</Text>}
              <Text style={styles.cardMeta}>{item.portions} portions · {item.ingredients.length} ingredients</Text>
            </View>
            <Text accessible={false} style={styles.chevron}>›</Text>
          </Pressable>
        )}
        ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyEmoji}>📖</Text><Text style={styles.emptyTitle}>No saved recipes yet</Text><Text style={styles.emptyText}>Ask Chef to save one when you find something worth making again.</Text></View>}
        contentContainerStyle={{ paddingBottom: 30 }}
      />

      <Modal visible={Boolean(selected)} animationType="slide" onRequestClose={closeRecipe}>
        {selected && (
          <ScrollView accessibilityViewIsModal keyboardShouldPersistTaps="handled" contentContainerStyle={styles.recipeDetail}>
            {draft ? (
              <>
                <View style={styles.detailHeader}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Cancel recipe editing" onPress={() => setDraft(null)} style={styles.detailAction}>
                    <Text style={styles.close}>Cancel</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Save recipe changes" onPress={saveEditing} style={styles.primaryAction}>
                    <Text style={styles.primaryActionText}>Save changes</Text>
                  </Pressable>
                </View>

                <View style={styles.editorIntro}>
                  <Text style={styles.editorIntroTitle}>Edit it like a recipe</Text>
                  <Text style={styles.editorIntroText}>Write naturally, one ingredient or step per line. Clear amounts such as “1 cup” stay structured for portion scaling; the rest can stay plain text.</Text>
                </View>

                <TextInput
                  accessibilityLabel="Recipe title"
                  value={draft.title}
                  onChangeText={(title) => setDraft((current) => current ? { ...current, title } : current)}
                  placeholder="Recipe title"
                  placeholderTextColor="#94a3b8"
                  style={styles.editorTitleInput}
                />

                <TextInput
                  accessibilityLabel="Recipe description"
                  value={draft.description}
                  onChangeText={(description) => setDraft((current) => current ? { ...current, description } : current)}
                  placeholder="Add a short description (optional)"
                  placeholderTextColor="#94a3b8"
                  multiline
                  style={styles.editorDescriptionInput}
                  textAlignVertical="top"
                />

                <View style={styles.editorSection}>
                  <Text style={styles.editorSectionTitle}>Ingredients</Text>
                  <Text style={styles.editorHelp}>One per line — for example “1 cup lentils” or “salt to taste”. Shopping is worked out from Pantry, so there are no extra fields to maintain here.</Text>
                  <TextInput
                    accessibilityLabel="Recipe ingredients"
                    value={draft.ingredientsText}
                    onChangeText={(ingredientsText) => setDraft((current) => current ? { ...current, ingredientsText } : current)}
                    placeholder={'1 cup lentils\n1/2 lemon\nsalt to taste'}
                    placeholderTextColor="#94a3b8"
                    multiline
                    style={[styles.editorTextArea, styles.ingredientsEditor]}
                    textAlignVertical="top"
                  />
                </View>

                <View style={styles.editorSection}>
                  <Text style={styles.editorSectionTitle}>Method</Text>
                  <Text style={styles.editorHelp}>One step per line. No need to number them — Creative Cooking does that when the recipe is displayed.</Text>
                  <TextInput
                    accessibilityLabel="Recipe method"
                    value={draft.stepsText}
                    onChangeText={(stepsText) => setDraft((current) => current ? { ...current, stepsText } : current)}
                    placeholder={'Warm the lentils.\nFinish with lemon and herbs.'}
                    placeholderTextColor="#94a3b8"
                    multiline
                    style={[styles.editorTextArea, styles.methodEditor]}
                    textAlignVertical="top"
                  />
                </View>

                <View style={styles.editorSection}>
                  <Text style={styles.editorSectionTitle}>Notes <Text style={styles.optionalText}>optional</Text></Text>
                  <TextInput
                    accessibilityLabel="Recipe notes"
                    value={draft.notesText}
                    onChangeText={(notesText) => setDraft((current) => current ? { ...current, notesText } : current)}
                    placeholder="Anything worth remembering next time"
                    placeholderTextColor="#94a3b8"
                    multiline
                    style={[styles.editorTextArea, styles.notesEditor]}
                    textAlignVertical="top"
                  />
                </View>
              </>
            ) : (
              <>
                <View style={styles.detailHeader}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Close recipe" onPress={closeRecipe} style={styles.detailAction}><Text style={styles.close}>Close</Text></Pressable>
                  <View style={styles.headerActions}>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Edit recipe ${selected.title}`} onPress={startEditing} style={styles.detailAction}><Text style={styles.edit}>Edit</Text></Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Delete recipe ${selected.title}`}
                      onPress={() => Alert.alert(
                        'Delete saved recipe?',
                        selected.title,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Delete', style: 'destructive', onPress: () => { deleteRecipe(selected.id); closeRecipe(); } }
                        ]
                      )}
                      style={styles.detailAction}
                    >
                      <Text style={styles.delete}>Delete</Text>
                    </Pressable>
                  </View>
                </View>

                <Text style={styles.detailTitle}>{selected.title}</Text>
                {!!selected.description && <Text style={styles.detailDescription}>{selected.description}</Text>}

                <View style={styles.portionCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.portionLabel}>Portions</Text>
                    <Text style={styles.portionHelp}>Numeric amounts scale automatically. Ranges and free text stay unchanged.</Text>
                  </View>
                  <View style={styles.portionControls}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Decrease portions"
                      accessibilityState={{ disabled: selected.portions <= 1 }}
                      disabled={selected.portions <= 1}
                      onPress={() => scalePortions(selected.portions - 1)}
                      style={[styles.portionButton, selected.portions <= 1 && styles.portionButtonDisabled]}
                    >
                      <Text style={styles.portionButtonText}>−</Text>
                    </Pressable>
                    <Text accessibilityLabel={`${selected.portions} portions`} style={styles.portionValue}>{selected.portions}</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Increase portions"
                      onPress={() => scalePortions(selected.portions + 1)}
                      style={styles.portionButton}
                    >
                      <Text style={styles.portionButtonText}>+</Text>
                    </Pressable>
                  </View>
                </View>

                <Text style={styles.sectionTitle}>Ingredients</Text>
                {selected.ingredients.map((ingredient, index) => (
                  <Text key={`${ingredient.name}-${index}`} style={styles.line}>• {ingredient.amount ? `${ingredient.amount} ` : ''}{ingredient.name}{ingredient.needsShopping ? '  🛒' : ''}</Text>
                ))}

                {!!shoppingRows.length && (
                  <View style={styles.shoppingSection}>
                    <Text style={styles.sectionTitle}>Shopping list</Text>
                    <Text style={styles.shoppingHelp}>Ingredients marked “Need to buy” or missing from Pantry appear here. Check things off as you buy them, then add the checked ingredients back to Pantry.</Text>
                    {shoppingRows.map(({ ingredient, index }) => {
                      const checked = checkedShopping.has(index);
                      return (
                        <Pressable
                          key={`shopping-${index}`}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked }}
                          accessibilityLabel={`${ingredient.name} purchased`}
                          onPress={() => toggleShoppingItem(index)}
                          style={[styles.shoppingRow, checked && styles.shoppingRowChecked]}
                        >
                          <View style={[styles.checkbox, checked && styles.checkboxChecked]}><Text style={styles.checkboxText}>{checked ? '✓' : ''}</Text></View>
                          <Text style={[styles.shoppingName, checked && styles.shoppingNameChecked]}>
                            {ingredient.amount ? `${ingredient.amount} ` : ''}{ingredient.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                    {!!checkedShopping.size && (
                      <Pressable accessibilityRole="button" onPress={addCheckedToPantry} style={styles.primaryAction}>
                        <Text style={styles.primaryActionText}>Add checked to Pantry</Text>
                      </Pressable>
                    )}
                  </View>
                )}

                <Text style={styles.sectionTitle}>Method</Text>
                {selected.steps.map((step, index) => <Text key={index} style={styles.step}><Text style={styles.stepNumber}>{index + 1}. </Text>{step}</Text>)}
                {!!selected.notes?.length && <><Text style={styles.sectionTitle}>Notes</Text>{selected.notes.map((note, index) => <Text key={index} style={styles.line}>• {note}</Text>)}</>}
              </>
            )}
          </ScrollView>
        )}
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, fontWeight: '800', color: '#94a3b8' },
  title: { fontSize: 32, lineHeight: 38, fontWeight: '800', color: '#172033' },
  settings: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  card: { marginHorizontal: 16, marginVertical: 6, padding: 17, borderRadius: 18, backgroundColor: 'white', borderWidth: 1, borderColor: '#e2e8f0', flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 72 },
  cardTitle: { color: '#172033', fontWeight: '700', fontSize: 18 },
  cardDescription: { color: '#64748b', marginTop: 5, lineHeight: 19 },
  cardMeta: { color: '#94a3b8', fontSize: 12, marginTop: 8, fontWeight: '600' },
  chevron: { color: '#94a3b8', fontSize: 32 },
  empty: { alignItems: 'center', padding: 54 },
  emptyEmoji: { fontSize: 44 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#334155', marginTop: 13 },
  emptyText: { textAlign: 'center', color: '#64748b', lineHeight: 21, marginTop: 8 },
  recipeDetail: { padding: 22, paddingBottom: 60, maxWidth: 760, width: '100%', alignSelf: 'center' },
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28, gap: 12, flexWrap: 'wrap' },
  headerActions: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  detailAction: { minHeight: 44, minWidth: 64, justifyContent: 'center' },
  close: { color: '#334155', fontWeight: '700' },
  edit: { color: '#1d4ed8', fontWeight: '700' },
  delete: { color: '#b91c1c', fontWeight: '700' },
  primaryAction: { minHeight: 44, backgroundColor: '#172033', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  primaryActionText: { color: 'white', fontWeight: '800' },
  detailTitle: { fontSize: 34, fontWeight: '800', color: '#172033' },
  detailDescription: { marginTop: 8, color: '#64748b', fontSize: 16, lineHeight: 23 },
  portionCard: { marginTop: 22, padding: 14, borderRadius: 16, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  portionLabel: { color: '#334155', fontWeight: '800', fontSize: 16 },
  portionHelp: { color: '#64748b', fontSize: 12.5, lineHeight: 18, marginTop: 3, maxWidth: 420 },
  portionControls: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  portionButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  portionButtonDisabled: { opacity: 0.4 },
  portionButtonText: { fontSize: 24, lineHeight: 26, color: '#334155', fontWeight: '600' },
  portionValue: { minWidth: 30, textAlign: 'center', color: '#172033', fontWeight: '800', fontSize: 18 },
  sectionTitle: { marginTop: 28, marginBottom: 10, fontSize: 19, fontWeight: '800', color: '#334155' },
  line: { color: '#475569', fontSize: 16, lineHeight: 24, marginBottom: 5 },
  step: { color: '#475569', fontSize: 16, lineHeight: 24, marginBottom: 14 },
  stepNumber: { fontWeight: '800', color: '#172033' },
  shoppingSection: { marginTop: 4 },
  shoppingHelp: { color: '#64748b', lineHeight: 19, marginBottom: 10 },
  shoppingRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  shoppingRowChecked: { opacity: 0.75 },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#94a3b8', alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: '#172033', borderColor: '#172033' },
  checkboxText: { color: 'white', fontWeight: '900' },
  shoppingName: { flex: 1, color: '#334155', fontSize: 16 },
  shoppingNameChecked: { textDecorationLine: 'line-through', color: '#64748b' },
  editorIntro: { marginBottom: 22, borderRadius: 16, backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#dcfce7', padding: 14 },
  editorIntroTitle: { color: '#166534', fontSize: 15, fontWeight: '800' },
  editorIntroText: { color: '#475569', fontSize: 13.5, lineHeight: 20, marginTop: 4 },
  editorTitleInput: { color: '#172033', fontSize: 32, lineHeight: 39, fontWeight: '800', paddingVertical: 6, paddingHorizontal: 0, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  editorDescriptionInput: { minHeight: 72, color: '#64748b', fontSize: 16, lineHeight: 23, paddingHorizontal: 0, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  editorSection: { marginTop: 26 },
  editorSectionTitle: { color: '#334155', fontSize: 19, fontWeight: '800', marginBottom: 5 },
  optionalText: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  editorHelp: { color: '#64748b', fontSize: 12.5, lineHeight: 18, marginBottom: 9 },
  editorTextArea: { borderRadius: 15, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc', paddingHorizontal: 14, paddingVertical: 12, color: '#172033', fontSize: 16, lineHeight: 24 },
  ingredientsEditor: { minHeight: 170 },
  methodEditor: { minHeight: 210 },
  notesEditor: { minHeight: 110 }
});
