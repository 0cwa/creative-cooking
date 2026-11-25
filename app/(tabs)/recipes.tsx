import {useAppTheme} from '@/theme/theme';
import { useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet, themeColor } from '@/theme/StyleSheet';
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
  missingPantryIngredients
} from '@/domain/recipeEditing';
import type { Recipe } from '@/domain/types';
import { copyStarterRecipe, starterRecipes, type StarterRecipe } from '@/domain/starterRecipes';
import type { RecipeHistoryEntry } from '@/loro/app/content-runtime-types';
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

function historyField(recipe: Recipe, entry: RecipeHistoryEntry) {
  if (entry.kind === 'recipe-step-field') return `Step ${(recipe.stepIds?.indexOf(entry.id ?? '') ?? -1) + 1}`;
  if (entry.kind === 'recipe-ingredient-field') {
    const ingredient = recipe.ingredients.find(item => item.id === entry.id);
    return entry.field === 'name' ? `Ingredient name · ${ingredient?.name ?? ''}` : `Ingredient amount · ${ingredient?.name ?? ''}`;
  }
  return entry.field[0].toUpperCase() + entry.field.slice(1);
}

export default function RecipesScreen() {
  useAppTheme();
  const router = useRouter();
  const {
    pantry,
    recipes,
    pendingRecipeTitle,
    createRecipe,
    updateRecipe,
    deleteRecipe,
    canEditSharedContent,
    readRecipeHistory,
    restoreRecipeEdit,
    beginWorkspaceTransition,
    flushCurrentWorkspace,
    refreshSharedCooking,
    sharedCookingRefreshPending
  } = useAppState();
  const [creating,setCreating]=useState(false);
  const [newTitle,setNewTitle]=useState('');
  const [newIngredients,setNewIngredients]=useState('');
  const [newSteps,setNewSteps]=useState('');
  const [creationError,setCreationError]=useState<string|null>(null);
  const [creationSaved,setCreationSaved]=useState(false);
  const [starter, setStarter] = useState<StarterRecipe | null>(null);
  const [starterSaving, setStarterSaving] = useState(false);
  const [starterError, setStarterError] = useState<string | null>(null);
  const [starterSavedTitle, setStarterSavedTitle] = useState<string | null>(null);
  const starterSaveInFlight = useRef(false);
  const pendingStarterId = useRef<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RecipeEditDraft | null>(null);
  const [history, setHistory] = useState<RecipeHistoryEntry[] | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [restoreSaved, setRestoreSaved] = useState(false);
  const historyRequest = useRef<symbol | null>(null);

  const startCreating = () => {
    setCreationError(null);
    setCreationSaved(false);
    setStarterSavedTitle(null);
    setCreating(true);
  };

  const previewStarter = (idea: StarterRecipe) => {
    setStarterError(null);
    setStarterSavedTitle(null);
    setStarter(idea);
  };

  const saveStarter = async () => {
    if (!starter || !canEditSharedContent || starterSaveInFlight.current) return;
    if (pendingRecipeTitle !== null && pendingStarterId.current !== starter.id) return;
    starterSaveInFlight.current = true;
    setStarterSaving(true);
    setStarterError(null);
    try {
      pendingStarterId.current = starter.id;
      const { refreshed } = await createRecipe(pendingRecipeTitle === null ? copyStarterRecipe(starter) : undefined);
      pendingStarterId.current = null;
      setCreationSaved(!refreshed);
      setStarterSavedTitle(starter.recipe.title);
      setStarter(null);
    } catch (error) {
      setStarterError(error instanceof Error ? error.message : 'Could not save this recipe. Try again.');
    } finally {
      starterSaveInFlight.current = false;
      setStarterSaving(false);
    }
  };

  const saveNewRecipe = async () => {
    if (!canEditSharedContent) return;
    let submission: RecipeDraft | undefined;
    if (pendingRecipeTitle===null) {
      const title = newTitle.trim();
      const ingredients = parseRecipeIngredientsText(newIngredients);
      const steps = parseRecipeTextList(newSteps);
      if (!title || !ingredients.length || !steps.length) {
        setCreationError('Add a title, ingredient and cooking step.');
        return;
      }
      submission={title,portions:2,ingredients,steps};
    }

    setCreationError(null);
    try {
      const {refreshed}=await createRecipe(submission);
      setCreationSaved(!refreshed);
      setCreating(false);
      setNewTitle('');
      setNewIngredients('');
      setNewSteps('');
    } catch (error) {
      setCreationError(error instanceof Error ? error.message : 'Could not save recipe.');
    }
  };

  const retryCookingRefresh = async () => {
    if (!refreshSharedCooking) return;
    setCreationError(null);
    try {
      const release=beginWorkspaceTransition();
      try {
        await flushCurrentWorkspace();
        await refreshSharedCooking();
      } finally {
        release();
      }
    } catch (error) {
      setCreationError(error instanceof Error ? error.message : 'Could not refresh recipes.');
    }
  };

  const selected = recipes.find((recipe) => recipe.id === selectedId) ?? null;
  const missingShoppingIngredients = selected
    ? new Set(missingPantryIngredients(selected.ingredients, pantry.map((item) => item.name)))
    : new Set<Recipe['ingredients'][number]>();
  const shoppingRows = selected
    ? (() => {
        return selected.ingredients
          .map((ingredient, index) => ({ ingredient, index }))
          .filter(({ ingredient }) => missingShoppingIngredients.has(ingredient));
      })()
    : [];

  const resetHistory = () => {
    historyRequest.current = null;
    setHistory(null);
    setHistoryBusy(false);
    setHistoryError(null);
    setRestoreSaved(false);
  };

  const selectRecipe = (id: string | null) => {
    resetHistory();
    setSelectedId(id);
    setDraft(null);
  };
  const openRecipe = (recipe: Recipe) => {
    setStarterSavedTitle(null);
    selectRecipe(recipe.id);
  };
  const closeRecipe = () => selectRecipe(null);

  const loadHistory = async (entry?: RecipeHistoryEntry) => {
    if (!selected || !readRecipeHistory || historyRequest.current) return;
    const request = Symbol(), recipeId = selected.id;
    const stillSelected = () => historyRequest.current === request;
    historyRequest.current = request;
    setHistoryBusy(true);
    setHistoryError(null);
    if (entry) setRestoreSaved(false);
    try {
      if (entry && restoreRecipeEdit) {
        const result = await restoreRecipeEdit(recipeId, entry);
        if (!stillSelected()) return;
        setHistory(null);
        setRestoreSaved(true);
        if (!result.refreshed) return;
      } else if (sharedCookingRefreshPending && refreshSharedCooking) {
        const release = beginWorkspaceTransition();
        try {
          await flushCurrentWorkspace();
          await refreshSharedCooking();
        } finally {
          release();
        }
      }
      if (!stillSelected()) return;
      const rows = await readRecipeHistory(recipeId);
      if (stillSelected()) setHistory(rows);
    } catch (error) {
      if (stillSelected()) setHistoryError(error instanceof Error ? error.message : 'Recipe history is unavailable.');
    } finally {
      if (stillSelected()) {
        historyRequest.current = null;
        setHistoryBusy(false);
      }
    }
  };

  const startEditing = () => {
    if (!selected) return;
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

  const recipeIdeas = (
    <View testID="recipe-ideas" style={styles.ideasSection}>
      <Text accessibilityRole="header" style={styles.ideasTitle}>A little inspiration</Text>
      <Text style={styles.ideasText}>Three simple ideas you can browse offline. Save a copy to change the portions, make it your own or plan a shop.</Text>
      <Text style={styles.ideasNote}>These built-in ideas are not tailored to your pantry or dietary needs.</Text>
      {starterRecipes.map(idea => (
        <Pressable
          key={idea.id}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${idea.recipe.title}`}
          onPress={() => previewStarter(idea)}
          style={styles.ideaCard}
        >
          <View style={styles.ideaText}>
            <Text style={styles.cardTitle}>{idea.recipe.title}</Text>
            <Text style={styles.cardDescription}>{idea.ingredientSummary}</Text>
            <Text style={styles.ideaMeta}>{idea.time} · {idea.recipe.portions} portions · Preview recipe</Text>
          </View>
          <Text accessible={false} style={styles.chevron}>›</Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <Screen>
      <View style={styles.header}>
        <View><Text style={styles.eyebrow}>YOUR COOKBOOK</Text><Text style={styles.title}>Recipes</Text></View>
        <View style={styles.headerActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Add recipe" disabled={!canEditSharedContent} onPress={startCreating} style={styles.shoppingLink}><Text style={styles.shoppingLinkText}>Add recipe</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => router.push('/shopping')} style={styles.shoppingLink}><Text style={styles.shoppingLinkText}>Shopping</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => router.push('/settings')} style={styles.settings}><SettingsGlyph /></Pressable>
        </View>
      </View>
      {starterSavedTitle && !sharedCookingRefreshPending && <Text accessibilityLiveRegion="polite" style={styles.savedNotice}>Saved {starterSavedTitle}. Open your copy below to cook, edit or plan a shop.</Text>}
      {creationSaved && <Text accessibilityLiveRegion="polite" style={styles.line}>{sharedCookingRefreshPending ? 'Recipe saved. Refresh cooking to see it.' : 'Recipe saved.'}</Text>}
      {sharedCookingRefreshPending && <Pressable accessibilityRole="button" onPress={() => void retryCookingRefresh()} style={styles.shoppingLink}>
        <Text style={styles.shoppingLinkText}>Retry cooking refresh</Text>
      </Pressable>}
      {!creating && sharedCookingRefreshPending && creationError && <Text accessibilityRole="alert" style={styles.line}>{creationError}</Text>}

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
        ListHeaderComponent={recipes.length ? <Text accessibilityRole="header" style={styles.savedHeading}>Your saved recipes</Text> : null}
        ListEmptyComponent={<>
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>📖</Text>
            <Text style={styles.emptyTitle}>Your cookbook starts here</Text>
            <Text style={styles.emptyText}>Try an idea below, or keep a recipe you already love. No account or AI connection needed.</Text>
            <Pressable accessibilityRole="button" disabled={!canEditSharedContent} onPress={startCreating} style={[styles.emptyAction, !canEditSharedContent && styles.disabledAction]}><Text style={styles.shoppingLinkText}>Add your own recipe</Text></Pressable>
          </View>
          {recipeIdeas}
        </>}
        ListFooterComponent={recipes.length ? recipeIdeas : null}
        contentContainerStyle={{ paddingBottom: 30 }}
      />

      <Modal visible={starter !== null} animationType="slide" onRequestClose={() => { if (!starterSaveInFlight.current) setStarter(null); }}>
        {starter && <ScrollView accessibilityViewIsModal style={styles.detailSurface} contentContainerStyle={styles.recipeDetail}>
          <View style={styles.detailHeader}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close recipe idea" disabled={starterSaving} onPress={() => setStarter(null)} style={styles.detailAction}><Text style={styles.close}>Close</Text></Pressable>
            <Text style={styles.ideaMeta}>Recipe idea · {starter.time.toLowerCase()}</Text>
          </View>
          <Text accessibilityRole="header" style={styles.detailTitle}>{starter.recipe.title}</Text>
          <Text style={styles.detailDescription}>{starter.recipe.description}</Text>
          <View style={styles.starterSaveCard}>
            <Text style={styles.line}>{starter.recipe.portions} portions. Previewing does not add anything to your kitchen.</Text>
            {!canEditSharedContent && <Text style={styles.ideasText}>You can read this idea here. Saving a copy needs an editable kitchen.</Text>}
            {pendingRecipeTitle !== null && pendingStarterId.current !== starter.id ? <>
              <Text style={styles.ideasText}>Finish saving {pendingRecipeTitle} before adding another recipe.</Text>
              <Pressable accessibilityRole="button" disabled={!canEditSharedContent || starterSaving} onPress={() => { setStarter(null); startCreating(); }} style={styles.shoppingLink}><Text style={styles.shoppingLinkText}>Finish recipe save</Text></Pressable>
            </> : <Pressable
              accessibilityRole="button"
              accessibilityLabel={pendingRecipeTitle === null ? 'Save a copy of this recipe' : 'Retry saving this recipe'}
              accessibilityState={{ disabled: !canEditSharedContent || starterSaving, busy: starterSaving }}
              disabled={!canEditSharedContent || starterSaving}
              onPress={() => void saveStarter()}
              style={[styles.primaryAction, (!canEditSharedContent || starterSaving) && styles.disabledAction]}
            ><Text style={styles.primaryActionText}>{starterSaving ? 'Saving…' : pendingRecipeTitle === null ? 'Save a copy' : 'Retry save'}</Text></Pressable>}
            {starterError && <Text accessibilityRole="alert" style={styles.delete}>{starterError}</Text>}
          </View>
          <Text style={styles.sectionTitle}>Ingredients</Text>
          {starter.recipe.ingredients.map(ingredient => <Text key={ingredient.name} style={styles.line}>• {ingredient.amount ? `${ingredient.amount} ` : ''}{ingredient.name}</Text>)}
          <Text style={styles.sectionTitle}>Method</Text>
          {starter.recipe.steps.map((step, index) => <Text key={index} style={styles.step}><Text style={styles.stepNumber}>{index + 1}. </Text>{step}</Text>)}
          <Text style={styles.sectionTitle}>Make it your own</Text>
          {starter.recipe.notes?.map(note => <Text key={note} style={styles.line}>• {note}</Text>)}
        </ScrollView>}
      </Modal>

      <Modal visible={creating} animationType="slide" onRequestClose={()=>{if(canEditSharedContent)setCreating(false);}}>
        <ScrollView accessibilityViewIsModal keyboardShouldPersistTaps="handled" style={styles.detailSurface} contentContainerStyle={styles.recipeDetail}>
          <View style={styles.detailHeader}>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel new recipe" disabled={!canEditSharedContent} onPress={()=>setCreating(false)} style={styles.detailAction}>
              <Text style={styles.close}>Cancel</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={pendingRecipeTitle===null?'Save new recipe':'Retry new recipe save'} disabled={!canEditSharedContent} onPress={saveNewRecipe} style={styles.primaryAction}>
              <Text style={styles.primaryActionText}>{pendingRecipeTitle===null?'Save recipe':'Retry save'}</Text>
            </Pressable>
          </View>
          {creationError && <Text accessibilityRole="alert" style={styles.line}>{creationError}</Text>}
          {pendingRecipeTitle!==null && <Text style={styles.line}>Resolve the save for {pendingRecipeTitle} before submitting another recipe.</Text>}
          <Text style={styles.editorIntroTitle}>New recipe</Text>
          <TextInput accessibilityLabel="New recipe title" editable={canEditSharedContent&&pendingRecipeTitle===null} placeholder="Recipe title" value={newTitle} onChangeText={setNewTitle} style={styles.editorTitleInput}/>
          <TextInput accessibilityLabel="New recipe ingredients" editable={canEditSharedContent&&pendingRecipeTitle===null} placeholder="One ingredient per line" value={newIngredients} onChangeText={setNewIngredients} multiline style={styles.editorTitleInput}/>
          <TextInput accessibilityLabel="New recipe steps" editable={canEditSharedContent&&pendingRecipeTitle===null} placeholder="One step per line" value={newSteps} onChangeText={setNewSteps} multiline style={styles.editorTitleInput}/>
        </ScrollView>
      </Modal>

      <Modal visible={Boolean(selected)} animationType="slide" onRequestClose={() => { if (!historyBusy) closeRecipe(); }}>
        {selected && (
          <ScrollView accessibilityViewIsModal keyboardShouldPersistTaps="handled" style={styles.detailSurface} contentContainerStyle={styles.recipeDetail}>
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
                  placeholderTextColor={themeColor('#94a3b8')}
                  style={styles.editorTitleInput}
                />

                <TextInput
                  accessibilityLabel="Recipe description"
                  value={draft.description}
                  onChangeText={(description) => setDraft((current) => current ? { ...current, description } : current)}
                  placeholder="Add a short description (optional)"
                  placeholderTextColor={themeColor('#94a3b8')}
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
                    placeholderTextColor={themeColor('#94a3b8')}
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
                    placeholderTextColor={themeColor('#94a3b8')}
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
                    placeholderTextColor={themeColor('#94a3b8')}
                    multiline
                    style={[styles.editorTextArea, styles.notesEditor]}
                    textAlignVertical="top"
                  />
                </View>
              </>
            ) : (
              <>
                <View style={styles.detailHeader}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Close recipe" disabled={historyBusy} onPress={closeRecipe} style={styles.detailAction}><Text style={styles.close}>Close</Text></Pressable>
                  <View style={styles.headerActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Add recipe" onPress={startCreating} style={styles.shoppingLink}><Text style={styles.shoppingLinkText}>Add recipe</Text></Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Edit recipe ${selected.title}`} disabled={historyBusy} onPress={startEditing} style={styles.detailAction}><Text style={styles.edit}>Edit</Text></Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Delete recipe ${selected.title}`}
                      disabled={historyBusy}
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
                  <Text key={`${ingredient.name}-${index}`} style={styles.line}>• {ingredient.amount ? `${ingredient.amount} ` : ''}{ingredient.name}{ingredient.needsShopping && missingShoppingIngredients.has(ingredient) ? '  🛒' : ''}</Text>
                ))}

                {!!shoppingRows.length && (
                  <View style={styles.shoppingSection}>
                    <Text style={styles.sectionTitle}>Need to shop?</Text>
                    <Text style={styles.shoppingHelp}>Ingredients marked to buy or missing from Pantry can be added to a shopping list.</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        closeRecipe();
                        router.push(`/shopping?recipeId=${encodeURIComponent(selected.id)}`);
                      }}
                      style={styles.primaryAction}
                    >
                      <Text style={styles.primaryActionText}>Add ingredients to shopping list ({shoppingRows.length})</Text>
                    </Pressable>
                  </View>
                )}

                <Text style={styles.sectionTitle}>Method</Text>
                {selected.steps.map((step, index) => <Text key={index} style={styles.step}><Text style={styles.stepNumber}>{index + 1}. </Text>{step}</Text>)}
                {!!selected.notes?.length && <><Text style={styles.sectionTitle}>Notes</Text>{selected.notes.map((note, index) => <Text key={index} style={styles.line}>• {note}</Text>)}</>}
                {readRecipeHistory && (
                  <View style={styles.shoppingSection}>
                    <Pressable accessibilityRole="button" disabled={historyBusy} onPress={() => void loadHistory()} style={styles.shoppingLink}>
                      <Text style={styles.shoppingLinkText}>{sharedCookingRefreshPending ? 'Retry recipe refresh' : history === null ? 'Show recipe edit history' : 'Refresh recipe edit history'}</Text>
                    </Pressable>
                    {restoreSaved && <Text accessibilityLiveRegion="polite" style={styles.line}>{sharedCookingRefreshPending ? 'Recipe edit saved. Refresh the recipe to see it.' : 'Recipe edit saved.'}</Text>}
                    {historyError && <Text accessibilityRole="alert" style={styles.delete}>{historyError}</Text>}
                    {history?.length === 0 && <Text style={styles.line}>No text edits recorded for this recipe.</Text>}
                    {history?.map(entry => (
                      <View key={entry.effectId}>
                        <Text style={styles.sectionTitle}>{historyField(selected, entry)}</Text>
                        <Text style={styles.line}>{(Array.isArray(entry.value) ? entry.value.join('\n') : entry.value) || 'Empty text'}</Text>
                        <Text style={styles.cardMeta}>{entry.status === 'current' ? 'Current edit' : entry.status === 'competing' ? 'Competing edit' : 'Earlier edit'}</Text>
                        {entry.status !== 'current' && restoreRecipeEdit && (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Restore ${historyField(selected, entry).toLowerCase()} edit`}
                            disabled={historyBusy || !canEditSharedContent}
                            onPress={() => void loadHistory(entry)}
                            style={styles.detailAction}
                          >
                            <Text style={styles.edit}>Restore this edit</Text>
                          </Pressable>
                        )}
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </ScrollView>
        )}
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, fontWeight: '800', color: '#94a3b8' },
  title: { fontSize: 32, lineHeight: 38, fontWeight: '800', color: '#172033' },
  settings: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  shoppingLink: { minHeight: 44, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  shoppingLinkText: { color: '#172033', fontWeight: '800' },
  card: { marginHorizontal: 16, marginVertical: 6, padding: 17, borderRadius: 18, backgroundColor: 'white', borderWidth: 1, borderColor: '#e2e8f0', flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 72 },
  cardTitle: { color: '#172033', fontWeight: '700', fontSize: 18 },
  cardDescription: { color: '#64748b', marginTop: 5, lineHeight: 19 },
  cardMeta: { color: '#94a3b8', fontSize: 12, marginTop: 8, fontWeight: '600' },
  chevron: { color: '#94a3b8', fontSize: 32 },
  savedNotice: { marginHorizontal: 20, marginBottom: 12, color: '#166534', fontSize: 14, lineHeight: 21 },
  savedHeading: { marginHorizontal: 20, marginTop: 12, marginBottom: 8, fontSize: 20, fontWeight: '800', color: '#334155' },
  ideasSection: { padding: 20, gap: 10 },
  ideasTitle: { fontSize: 22, fontWeight: '800', color: '#172033' },
  ideasText: { color: '#475569', fontSize: 15, lineHeight: 22 },
  ideasNote: { color: '#64748b', fontSize: 13, lineHeight: 20, marginBottom: 4 },
  ideaCard: { padding: 16, borderRadius: 18, backgroundColor: 'white', borderWidth: 1, borderColor: '#e2e8f0', flexDirection: 'row', alignItems: 'center', gap: 12 },
  ideaText: { flex: 1, minWidth: 0 },
  ideaMeta: { color: '#475569', fontSize: 13, lineHeight: 19, marginTop: 8 },
  starterSaveCard: { backgroundColor: '#f0fdf4', borderRadius: 16, padding: 16, gap: 10, marginTop: 20 },
  disabledAction: { opacity: 0.45 },
  empty: { alignItems: 'center', paddingHorizontal: 28, paddingTop: 26, paddingBottom: 16 },
  emptyEmoji: { fontSize: 44 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#334155', marginTop: 13 },
  emptyText: { textAlign: 'center', color: '#64748b', lineHeight: 21, marginTop: 8 },
  emptyAction: { marginTop: 16, minHeight: 44, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  detailSurface: { backgroundColor: '#f8fafc' },
  recipeDetail: { padding: 22, paddingBottom: 60, maxWidth: 760, width: '100%', alignSelf: 'center' },
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28, gap: 12, flexWrap: 'wrap' },
  detailAction: { minHeight: 44, minWidth: 64, justifyContent: 'center' },
  close: { color: '#334155', fontWeight: '700' },
  edit: { color: '#1d4ed8', fontWeight: '700' },
  delete: { color: '#b91c1c', fontWeight: '700' },
  primaryAction: { minHeight: 44, backgroundColor: '#166534', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
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
  checkboxChecked: { backgroundColor: '#166534', borderColor: '#166534' },
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
