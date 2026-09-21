import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { SettingsGlyph } from '@/components/SettingsGlyph';
import { scaleRecipeIngredients, shoppingIngredients } from '@/domain/recipeEditing';
import type { Recipe, RecipeIngredient } from '@/domain/types';
import { useAppState } from '@/state/AppState';

type RecipeDraft = Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;

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

function cleanRecipeDraft(draft: RecipeDraft): RecipeDraft {
  const ingredients = draft.ingredients
    .map((ingredient) => ({
      name: ingredient.name.trim(),
      amount: ingredient.amount?.trim() || undefined,
      needsShopping: ingredient.needsShopping ? true : undefined
    }))
    .filter((ingredient) => ingredient.name);

  const steps = draft.steps.map((step) => step.trim()).filter(Boolean);
  const notes = draft.notes?.map((note) => note.trim()).filter(Boolean);

  return {
    ...draft,
    title: draft.title.trim(),
    description: draft.description?.trim() || undefined,
    ingredients,
    steps,
    notes: notes?.length ? notes : undefined
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
  const [draft, setDraft] = useState<RecipeDraft | null>(null);
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
    setDraft(toRecipeDraft(selected));
  };

  const saveEditing = () => {
    if (!selected || !draft) return;
    const cleaned = cleanRecipeDraft(draft);

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

  const updateDraftIngredient = (index: number, patch: Partial<RecipeIngredient>) => {
    setDraft((current) => current ? {
      ...current,
      ingredients: current.ingredients.map((ingredient, ingredientIndex) => (
        ingredientIndex === index ? { ...ingredient, ...patch } : ingredient
      ))
    } : current);
  };

  const removeDraftIngredient = (index: number) => {
    setDraft((current) => current ? {
      ...current,
      ingredients: current.ingredients.filter((_, ingredientIndex) => ingredientIndex !== index)
    } : current);
  };

  const updateDraftStep = (index: number, value: string) => {
    setDraft((current) => current ? {
      ...current,
      steps: current.steps.map((step, stepIndex) => stepIndex === index ? value : step)
    } : current);
  };

  const updateDraftNote = (index: number, value: string) => {
    setDraft((current) => current ? {
      ...current,
      notes: (current.notes ?? []).map((note, noteIndex) => noteIndex === index ? value : note)
    } : current);
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

                <Text style={styles.editLabel}>Title</Text>
                <TextInput
                  accessibilityLabel="Recipe title"
                  value={draft.title}
                  onChangeText={(title) => setDraft((current) => current ? { ...current, title } : current)}
                  placeholder="Recipe title"
                  placeholderTextColor="#94a3b8"
                  style={styles.input}
                />

                <Text style={styles.editLabel}>Description</Text>
                <TextInput
                  accessibilityLabel="Recipe description"
                  value={draft.description ?? ''}
                  onChangeText={(description) => setDraft((current) => current ? { ...current, description } : current)}
                  placeholder="Optional description"
                  placeholderTextColor="#94a3b8"
                  multiline
                  style={[styles.input, styles.multilineInput]}
                  textAlignVertical="top"
                />

                <Text style={styles.sectionTitle}>Ingredients</Text>
                <View style={styles.editList}>
                  {draft.ingredients.map((ingredient, index) => (
                    <View key={index} style={styles.editCard}>
                      <View style={styles.ingredientInputs}>
                        <TextInput
                          accessibilityLabel={`Amount for ingredient ${index + 1}`}
                          value={ingredient.amount ?? ''}
                          onChangeText={(amount) => updateDraftIngredient(index, { amount })}
                          placeholder="Amount"
                          placeholderTextColor="#94a3b8"
                          style={[styles.input, styles.amountInput]}
                        />
                        <TextInput
                          accessibilityLabel={`Ingredient ${index + 1} name`}
                          value={ingredient.name}
                          onChangeText={(name) => updateDraftIngredient(index, { name })}
                          placeholder="Ingredient"
                          placeholderTextColor="#94a3b8"
                          style={[styles.input, styles.nameInput]}
                        />
                      </View>
                      <View style={styles.editCardActions}>
                        <Pressable
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: Boolean(ingredient.needsShopping) }}
                          accessibilityLabel={`Ingredient ${index + 1} needs shopping`}
                          onPress={() => updateDraftIngredient(index, { needsShopping: !ingredient.needsShopping })}
                          style={[styles.shoppingToggle, ingredient.needsShopping && styles.shoppingToggleActive]}
                        >
                          <Text style={[styles.shoppingToggleText, ingredient.needsShopping && styles.shoppingToggleTextActive]}>
                            {ingredient.needsShopping ? '✓ Need to buy' : 'Need to buy'}
                          </Text>
                        </Pressable>
                        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ingredient ${index + 1}`} onPress={() => removeDraftIngredient(index)} style={styles.removeButton}>
                          <Text style={styles.removeText}>Remove</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDraft((current) => current ? {
                    ...current,
                    ingredients: [...current.ingredients, { name: '', amount: '', needsShopping: false }]
                  } : current)}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>+ Add ingredient</Text>
                </Pressable>

                <Text style={styles.sectionTitle}>Method</Text>
                <View style={styles.editList}>
                  {draft.steps.map((step, index) => (
                    <View key={index} style={styles.editCard}>
                      <Text style={styles.stepNumber}>{index + 1}.</Text>
                      <TextInput
                        accessibilityLabel={`Recipe step ${index + 1}`}
                        value={step}
                        onChangeText={(value) => updateDraftStep(index, value)}
                        placeholder="Cooking step"
                        placeholderTextColor="#94a3b8"
                        multiline
                        style={[styles.input, styles.stepInput]}
                        textAlignVertical="top"
                      />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove recipe step ${index + 1}`}
                        onPress={() => setDraft((current) => current ? {
                          ...current,
                          steps: current.steps.filter((_, stepIndex) => stepIndex !== index)
                        } : current)}
                        style={styles.removeButton}
                      >
                        <Text style={styles.removeText}>Remove</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDraft((current) => current ? { ...current, steps: [...current.steps, ''] } : current)}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>+ Add step</Text>
                </Pressable>

                <Text style={styles.sectionTitle}>Notes</Text>
                <View style={styles.editList}>
                  {(draft.notes ?? []).map((note, index) => (
                    <View key={index} style={styles.editCard}>
                      <TextInput
                        accessibilityLabel={`Recipe note ${index + 1}`}
                        value={note}
                        onChangeText={(value) => updateDraftNote(index, value)}
                        placeholder="Optional note"
                        placeholderTextColor="#94a3b8"
                        multiline
                        style={[styles.input, styles.stepInput]}
                        textAlignVertical="top"
                      />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove recipe note ${index + 1}`}
                        onPress={() => setDraft((current) => current ? {
                          ...current,
                          notes: (current.notes ?? []).filter((_, noteIndex) => noteIndex !== index)
                        } : current)}
                        style={styles.removeButton}
                      >
                        <Text style={styles.removeText}>Remove</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDraft((current) => current ? {
                    ...current,
                    notes: [...(current.notes ?? []), '']
                  } : current)}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>+ Add note</Text>
                </Pressable>
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
  secondaryButton: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: '#cbd5e1', paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  secondaryButtonText: { color: '#334155', fontWeight: '700' },
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
  editLabel: { color: '#334155', fontWeight: '800', marginBottom: 7, marginTop: 14 },
  input: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: '#cbd5e1', paddingHorizontal: 12, paddingVertical: 9, color: '#172033', backgroundColor: '#fff' },
  multilineInput: { minHeight: 92 },
  editList: { gap: 10 },
  editCard: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 14, padding: 12, gap: 10, backgroundColor: '#f8fafc' },
  ingredientInputs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  amountInput: { flexGrow: 0, flexBasis: 120, minWidth: 100 },
  nameInput: { flex: 1, minWidth: 180 },
  editCardActions: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  shoppingToggle: { minHeight: 40, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#e2e8f0', justifyContent: 'center' },
  shoppingToggleActive: { backgroundColor: '#fef3c7' },
  shoppingToggleText: { color: '#475569', fontWeight: '700' },
  shoppingToggleTextActive: { color: '#92400e' },
  removeButton: { minHeight: 40, paddingHorizontal: 8, justifyContent: 'center', alignSelf: 'flex-start' },
  removeText: { color: '#b91c1c', fontWeight: '700' },
  stepInput: { flex: 1, minHeight: 72 }
});
