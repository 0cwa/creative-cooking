import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { missingPantryIngredients } from '@/domain/recipeEditing';
import type { ShoppingItem } from '@/domain/types';
import { useAppState } from '@/state/AppState';

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function sourceKey(recipeId: string, ingredientId?: string): string | undefined {
  return ingredientId ? `${recipeId}\0${ingredientId}` : undefined;
}

export default function ShoppingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ recipeId?: string }>();
  const recipeId = typeof params.recipeId === 'string' ? params.recipeId : undefined;
  const {
    pantry,
    recipes,
    shopping,
    createShoppingList,
    addShoppingItems,
    updateShoppingItem,
    removeShoppingItem,
    removeShoppingList,
    setShoppingItemChecked,
    startNewPurchaseCycle,
    purchaseCheckedShoppingItems
  } = useAppState();

  const activeLists = shopping.lists.filter((list) => !list.removedAt);
  const [selectedListId, setSelectedListId] = useState<string | null>(activeLists[0]?.id ?? null);
  const [listName, setListName] = useState('Shopping list');
  const [itemName, setItemName] = useState('');
  const [itemQuantity, setItemQuantity] = useState('');
  const [itemUnit, setItemUnit] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingQuantity, setEditingQuantity] = useState('');
  const [editingUnit, setEditingUnit] = useState('');
  const [previewSelectedIds, setPreviewSelectedIds] = useState<Set<string>>(new Set());
  const [confirmListRemoval, setConfirmListRemoval] = useState(false);
  const [message, setMessage] = useState('');
  const [focusedField, setFocusedField] = useState<string | null>(null);

  const sourceRecipe = recipes.find((recipe) => recipe.id === recipeId) ?? null;
  const previewRows = useMemo(() => {
    if (!sourceRecipe) return [];
    return missingPantryIngredients(sourceRecipe.ingredients, pantry.map((item) => item.name))
      .map((ingredient, index) => ({ ingredient, index }));
  }, [sourceRecipe, pantry]);

  useEffect(() => {
    if (!activeLists.some((list) => list.id === selectedListId)) {
      setSelectedListId(activeLists[0]?.id ?? null);
    }
  }, [activeLists, selectedListId]);

  const previewSignature = previewRows.map(({ ingredient }) => ingredient.id ?? ingredient.name).join('|');
  useEffect(() => {
    setPreviewSelectedIds(new Set(previewRows.map(({ ingredient }) => ingredient.id ?? ingredient.name)));
  }, [recipeId, previewSignature]);

  const selectedList = activeLists.find((list) => list.id === selectedListId) ?? null;
  const activeItems = selectedList
    ? shopping.items.filter((item) => item.listId === selectedList.id && !item.removedAt)
    : [];
  const checkedItems = selectedList
    ? activeItems.filter((item) => item.checked && item.purchaseCycleId === selectedList.currentCycleId
      && item.purchasedCycleId !== selectedList.currentCycleId)
    : [];
  const existingSourceRefs = new Set(activeItems
    .filter((item) => item.recipeId && item.ingredientId)
    .map((item) => `${item.recipeId}\0${item.ingredientId}`));
  const selectedPreviewRows = previewRows.filter(({ ingredient }) => (
    previewSelectedIds.has(ingredient.id ?? ingredient.name)
  ));
  const addablePreviewRows = selectedPreviewRows.filter(({ ingredient }) => (
    !sourceKey(sourceRecipe?.id ?? '', ingredient.id)
    || !existingSourceRefs.has(sourceKey(sourceRecipe?.id ?? '', ingredient.id) ?? '')
  ));

  const createList = () => {
    const name = listName.trim();
    if (!name) {
      setMessage('Enter a name for this shopping list.');
      return;
    }
    const id = newId('shopping-list');
    createShoppingList({ id, cycleId: newId('shopping-cycle'), name, at: new Date().toISOString() });
    setSelectedListId(id);
    setListName('');
    setMessage(`Created ${name}.`);
  };

  const addManualItem = () => {
    if (!selectedList) {
      setMessage('Create a shopping list before adding items.');
      return;
    }
    if (!itemName.trim()) {
      setMessage('Enter an item name.');
      return;
    }
    addShoppingItems(selectedList.id, [{
      id: newId('shopping-item'),
      name: itemName,
      ...(itemQuantity ? { displayQuantity: itemQuantity } : {}),
      ...(itemUnit ? { displayUnit: itemUnit } : {}),
      at: new Date().toISOString()
    }]);
    setItemName('');
    setItemQuantity('');
    setItemUnit('');
    setMessage(`${itemName.trim()} added to ${selectedList.name}.`);
  };

  const addRecipeItems = () => {
    if (!selectedList || !sourceRecipe) return;
    if (!selectedPreviewRows.length) {
      setMessage('Select at least one ingredient to add.');
      return;
    }
    if (!addablePreviewRows.length) {
      setMessage('Those ingredients are already on this list.');
      return;
    }
    const at = new Date().toISOString();
    addShoppingItems(selectedList.id, addablePreviewRows.map(({ ingredient }) => ({
      id: newId('shopping-item'),
      name: ingredient.name,
      recipeId: sourceRecipe.id,
      ...(ingredient.id ? { ingredientId: ingredient.id } : {}),
      ...(ingredient.amount === undefined ? {} : { displayQuantity: ingredient.amount }),
      at
    })));
    setMessage(`${addablePreviewRows.length} ingredient${addablePreviewRows.length === 1 ? '' : 's'} added to ${selectedList.name}.`);
  };

  const beginEdit = (item: ShoppingItem) => {
    setEditingItemId(item.id);
    setEditingName(item.name);
    setEditingQuantity(item.displayQuantity ?? '');
    setEditingUnit(item.displayUnit ?? '');
    setMessage('');
  };

  const saveEdit = (item: ShoppingItem) => {
    if (!editingName.trim()) {
      setMessage('Enter an item name.');
      return;
    }
    updateShoppingItem(item.id, {
      name: editingName,
      ...(editingQuantity ? { displayQuantity: editingQuantity } : {}),
      ...(editingUnit ? { displayUnit: editingUnit } : {})
    });
    setEditingItemId(null);
    setMessage('Shopping item updated.');
  };

  const purchaseChecked = () => {
    if (!selectedList || !checkedItems.length) return;
    purchaseCheckedShoppingItems(
      selectedList.id,
      selectedList.currentCycleId,
      newId('shopping-purchase'),
      new Date().toISOString()
    );
    setMessage(`${checkedItems.length} checked item${checkedItems.length === 1 ? '' : 's'} recorded for this purchase. Pantry entries are added only once.`);
  };

  const beginNewCycle = () => {
    if (!selectedList) return;
    startNewPurchaseCycle(selectedList.id, newId('shopping-cycle'));
    setMessage('A new purchase cycle has started.');
  };

  const removeList = () => {
    if (!selectedList) return;
    if (!confirmListRemoval) {
      setConfirmListRemoval(true);
      return;
    }
    removeShoppingList(selectedList.id);
    setConfirmListRemoval(false);
    setMessage(`${selectedList.name} removed.`);
  };

  const renderTextField = (
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    placeholder: string,
    style?: object
  ) => (
    <TextInput
      accessibilityLabel={label}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="#64748b"
      onFocus={() => setFocusedField(label)}
      onBlur={() => setFocusedField((current) => current === label ? null : current)}
      style={[styles.input, style, focusedField === label && styles.inputFocused]}
    />
  );

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>YOUR KITCHEN</Text>
            <Text accessibilityRole="header" style={styles.title}>Shopping list</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backButtonText}>Back</Text>
          </Pressable>
        </View>

        <Text style={styles.localNotice}>Saved on this device only. Shopping lists are not synced.</Text>

        {activeLists.length > 1 && (
          <View style={styles.listPicker}>
            {activeLists.map((list) => {
              const selected = list.id === selectedList?.id;
              return (
                <Pressable
                  key={list.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => { setSelectedListId(list.id); setConfirmListRemoval(false); setMessage(''); }}
                  style={[styles.listChoice, selected && styles.listChoiceSelected]}
                >
                  <Text style={[styles.listChoiceText, selected && styles.listChoiceTextSelected]}>{list.name}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {!selectedList && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Create a list</Text>
            {renderTextField('New shopping list name', listName, setListName, 'Shopping list')}
            <Pressable accessibilityRole="button" onPress={createList} style={styles.primaryAction}>
              <Text style={styles.primaryActionText}>Create shopping list</Text>
            </Pressable>
          </View>
        )}

        {selectedList && (
          <>
            <View style={styles.sectionHeading}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>{selectedList.name}</Text>
                <Text style={styles.muted}>{activeItems.length} {activeItems.length === 1 ? 'item' : 'items'} · purchase cycle active</Text>
              </View>
              <Pressable accessibilityRole="button" onPress={removeList} style={styles.textButton}>
                <Text style={styles.removeText}>{confirmListRemoval ? 'Confirm remove list' : 'Remove list'}</Text>
              </Pressable>
            </View>

            {confirmListRemoval && (
              <View style={styles.confirmRow}>
                <Text style={styles.confirmText}>Remove this list? Its records will remain in local history.</Text>
                <Pressable accessibilityRole="button" onPress={() => setConfirmListRemoval(false)} style={styles.smallButton}>
                  <Text style={styles.smallButtonText}>Keep list</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.addForm}>
              {renderTextField('Shopping item name', itemName, setItemName, 'Add an item', styles.nameInput)}
              {renderTextField('Shopping quantity', itemQuantity, setItemQuantity, 'Quantity', styles.quantityInput)}
              {renderTextField('Shopping unit', itemUnit, setItemUnit, 'Unit', styles.unitInput)}
              <Pressable accessibilityRole="button" onPress={addManualItem} style={styles.secondaryAction}>
                <Text style={styles.secondaryActionText}>Add</Text>
              </Pressable>
            </View>

            {activeItems.length === 0 ? (
              <View style={styles.emptyList}>
                <Text style={styles.emptyTitle}>Nothing on this list yet</Text>
                <Text style={styles.emptyText}>Add an item above or bring in ingredients from a saved recipe.</Text>
              </View>
            ) : (
              <View style={styles.items}>
                {activeItems.map((item) => {
                  const purchased = item.purchasedCycleId === selectedList.currentCycleId;
                  const checked = item.checked;
                  const editing = editingItemId === item.id;
                  return (
                    <View key={item.id} style={[styles.itemRow, (checked || purchased) && styles.itemRowDone]}>
                      {editing ? (
                        <View style={styles.editForm}>
                          {renderTextField('Edit item name', editingName, setEditingName, 'Item name')}
                          <View style={styles.editDetails}>
                            {renderTextField('Edit item quantity', editingQuantity, setEditingQuantity, 'Quantity', styles.quantityInput)}
                            {renderTextField('Edit item unit', editingUnit, setEditingUnit, 'Unit', styles.unitInput)}
                          </View>
                          <View style={styles.rowActions}>
                            <Pressable accessibilityRole="button" onPress={() => saveEdit(item)} style={styles.smallButton}><Text style={styles.smallButtonText}>Save</Text></Pressable>
                            <Pressable accessibilityRole="button" onPress={() => setEditingItemId(null)} style={styles.textButton}><Text style={styles.muted}>Cancel</Text></Pressable>
                          </View>
                        </View>
                      ) : (
                        <>
                          <Pressable
                            accessibilityRole="checkbox"
                            accessibilityLabel={`Check ${item.name}`}
                            accessibilityState={{ checked, disabled: purchased }}
                            aria-checked={checked}
                            disabled={purchased}
                            onPress={() => setShoppingItemChecked(item.id, selectedList.currentCycleId, !checked)}
                            style={[styles.checkbox, checked && styles.checkboxChecked, purchased && styles.checkboxDisabled]}
                          >
                            <Text style={styles.checkboxText}>{checked ? '✓' : ''}</Text>
                          </Pressable>
                          <View style={styles.itemCopy}>
                            <Text style={[styles.itemName, (checked || purchased) && styles.itemNameDone]}>{item.name}</Text>
                            {!!(item.displayQuantity || item.displayUnit) && (
                              <Text style={styles.itemDetail}>{[item.displayQuantity, item.displayUnit].filter(Boolean).join(' ')}</Text>
                            )}
                            {!!item.recipeId && <Text style={styles.sourceText}>{recipes.find((recipe) => recipe.id === item.recipeId)?.title ?? 'Saved recipe'}</Text>}
                          </View>
                          {purchased
                            ? <Text style={styles.purchasedLabel}>Purchased</Text>
                            : <View style={styles.rowActions}>
                                <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${item.name}`} onPress={() => beginEdit(item)} style={styles.iconButton}><Text style={styles.actionText}>Edit</Text></Pressable>
                                <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item.name}`} onPress={() => { removeShoppingItem(item.id); setMessage(`${item.name} removed.`); }} style={styles.iconButton}><Text style={styles.removeText}>Remove</Text></Pressable>
                              </View>}
                        </>
                      )}
                    </View>
                  );
                })}
              </View>
            )}

            <View style={styles.cycleActions}>
              {!!checkedItems.length && (
                <Pressable accessibilityRole="button" onPress={purchaseChecked} style={styles.primaryAction}>
                  <Text style={styles.primaryActionText}>Add checked to Pantry ({checkedItems.length})</Text>
                </Pressable>
              )}
              <Pressable accessibilityRole="button" onPress={beginNewCycle} style={styles.secondaryAction}>
                <Text style={styles.secondaryActionText}>Start new purchase cycle</Text>
              </Pressable>
            </View>
          </>
        )}

        {sourceRecipe && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Add from {sourceRecipe.title}</Text>
            {previewRows.length === 0 ? (
              <Text style={styles.emptyText}>All recipe ingredients are already in Pantry, and none are marked to buy.</Text>
            ) : (
              <>
                <Text style={styles.muted}>Ingredients marked to buy or missing from Pantry. Choose what to add.</Text>
                {previewRows.map(({ ingredient, index }) => {
                  const key = ingredient.id ?? `${sourceRecipe.id}-${index}`;
                  const checked = previewSelectedIds.has(ingredient.id ?? ingredient.name);
                  return (
                    <Pressable
                      key={key}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked }}
                      aria-checked={checked}
                      accessibilityLabel={`Select ingredient ${ingredient.name} ${index + 1}`}
                      onPress={() => setPreviewSelectedIds((current) => {
                        const next = new Set(current);
                        const id = ingredient.id ?? ingredient.name;
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })}
                      style={styles.previewRow}
                    >
                      <View style={[styles.checkbox, checked && styles.checkboxChecked]}><Text style={styles.checkboxText}>{checked ? '✓' : ''}</Text></View>
                      <Text style={styles.itemName}>{ingredient.amount ? `${ingredient.amount} ` : ''}{ingredient.name}</Text>
                    </Pressable>
                  );
                })}
                <Text style={styles.confirmText}>
                  {addablePreviewRows.length} selected ingredient{addablePreviewRows.length === 1 ? '' : 's'} will be added to {selectedList?.name ?? 'your selected list'}.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={!selectedList || !addablePreviewRows.length}
                  onPress={addRecipeItems}
                  style={[styles.primaryAction, (!selectedList || !addablePreviewRows.length) && styles.disabledAction]}
                >
                  <Text style={styles.primaryActionText}>Add {addablePreviewRows.length} ingredients to list</Text>
                </Pressable>
              </>
            )}
          </View>
        )}

        {selectedList && (
          <View style={styles.createAnother}>
            <Text style={styles.sectionTitle}>Create another list</Text>
            <View style={styles.inlineForm}>
              {renderTextField('New shopping list name', listName, setListName, 'List name', styles.nameInput)}
              <Pressable accessibilityRole="button" onPress={createList} style={styles.secondaryAction}>
                <Text style={styles.secondaryActionText}>Create</Text>
              </Pressable>
            </View>
          </View>
        )}
        <Text accessibilityLiveRegion="polite" style={styles.status}>{message}</Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 52, width: '100%', maxWidth: 820, alignSelf: 'center' },
  header: { paddingBottom: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, fontWeight: '800', color: '#64748b' },
  title: { fontSize: 32, lineHeight: 38, fontWeight: '800', color: '#172033' },
  backButton: { minHeight: 44, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  backButtonText: { color: '#172033', fontWeight: '700' },
  localNotice: { marginBottom: 18, color: '#334155', lineHeight: 20, padding: 12, backgroundColor: '#f1f5f9', borderRadius: 12 },
  listPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  listChoice: { minHeight: 40, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: 'white' },
  listChoiceSelected: { backgroundColor: '#172033', borderColor: '#172033' },
  listChoiceText: { color: '#334155', fontWeight: '700' },
  listChoiceTextSelected: { color: 'white' },
  section: { marginTop: 22 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, marginBottom: 8 },
  sectionTitle: { marginTop: 8, marginBottom: 8, fontSize: 20, fontWeight: '800', color: '#334155' },
  muted: { color: '#475569', lineHeight: 19 },
  input: { minHeight: 46, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 12, backgroundColor: 'white', paddingHorizontal: 13, paddingVertical: 10, color: '#172033', fontSize: 16 },
  inputFocused: { borderWidth: 2, borderColor: '#1d4ed8' },
  addForm: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 12 },
  inlineForm: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  nameInput: { flexGrow: 1, flexBasis: 170 },
  quantityInput: { width: 112 },
  unitInput: { width: 96 },
  primaryAction: { minHeight: 46, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#172033', borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryActionText: { color: 'white', fontWeight: '800' },
  secondaryAction: { minHeight: 46, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#e2e8f0', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  secondaryActionText: { color: '#172033', fontWeight: '800' },
  disabledAction: { opacity: 0.5 },
  emptyList: { paddingVertical: 20 },
  emptyTitle: { color: '#334155', fontSize: 17, fontWeight: '700' },
  emptyText: { color: '#475569', lineHeight: 20, marginTop: 4 },
  items: { marginTop: 4 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 62, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  itemRowDone: { opacity: 0.82 },
  checkbox: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, borderColor: '#94a3b8', backgroundColor: 'white', alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { borderColor: '#172033', backgroundColor: '#172033' },
  checkboxDisabled: { opacity: 0.7 },
  checkboxText: { color: 'white', fontWeight: '900' },
  itemCopy: { flex: 1 },
  itemName: { color: '#172033', fontSize: 16, fontWeight: '600', flex: 1 },
  itemNameDone: { textDecorationLine: 'line-through', color: '#475569' },
  itemDetail: { color: '#475569', fontSize: 14, marginTop: 2 },
  sourceText: { color: '#475569', fontSize: 12, marginTop: 3 },
  purchasedLabel: { color: '#166534', fontWeight: '800', fontSize: 12 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconButton: { minHeight: 40, paddingHorizontal: 7, justifyContent: 'center' },
  actionText: { color: '#1d4ed8', fontWeight: '700' },
  removeText: { color: '#b91c1c', fontWeight: '700' },
  textButton: { minHeight: 40, paddingHorizontal: 8, justifyContent: 'center' },
  editForm: { flex: 1, gap: 8 },
  editDetails: { flexDirection: 'row', gap: 8 },
  smallButton: { minHeight: 40, paddingHorizontal: 13, borderRadius: 10, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  smallButtonText: { color: '#172033', fontWeight: '700' },
  cycleActions: { gap: 8, marginTop: 16 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginVertical: 8 },
  confirmText: { color: '#334155', lineHeight: 20, marginTop: 8, marginBottom: 4 },
  previewRow: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 10 },
  createAnother: { marginTop: 26, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  status: { color: '#334155', minHeight: 24, marginTop: 16, fontWeight: '600' }
});
