import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import { useAppState } from '@/state/AppState';
import type { HouseholdWorkspace } from '@/domain/types';

function HouseholdDetails({ household }: { household: HouseholdWorkspace }) {
  const app = useAppState();
  const [allergies, setAllergies] = useState(household.requirements.allergies.join(', '));
  const [diet, setDiet] = useState(household.requirements.diet);
  const [saved, setSaved] = useState(false);
  return <View style={styles.card}>
    <Text style={styles.heading}>{household.name} requirements</Text>
    <Text style={styles.help}>Used when cooking for this household; included in Chef requests alongside your personal allergies. Review ingredients and product labels before cooking.</Text>
    <TextInput accessibilityLabel="Household allergies" value={allergies} onChangeText={(value) => { setAllergies(value); setSaved(false); }} placeholder="Allergies, separated by commas" style={styles.input} />
    <View style={styles.row}>{(['none', 'vegetarian', 'vegan'] as const).map((option) => <Pressable key={option} accessibilityRole="radio" accessibilityLabel={option === 'none' ? 'No dietary preference' : option} accessibilityState={{ checked: diet === option }} onPress={() => { setDiet(option); setSaved(false); }} style={[styles.button, diet === option && styles.selected]}><Text>{option === 'none' ? 'No preference' : option}</Text></Pressable>)}</View>
    <Pressable accessibilityRole="button" accessibilityLabel="Save household requirements" style={styles.button} onPress={() => { app.updateHouseholdRequirements(household.id, { allergies: allergies.split(',').map((value) => value.trim()).filter(Boolean), diet }); setSaved(true); }}><Text>Save requirements</Text></Pressable>
    {saved && <Text style={styles.help}>Requirements saved</Text>}
    <Text style={styles.heading}>Selected recipe copies</Text>
    <Text style={styles.help}>Copy only recipes you choose. Copies leave personal notes and shopping flags behind. Editing or deleting the original does not change this snapshot.</Text>
    {!household.recipes.length && <Text style={styles.help}>No recipe copies yet</Text>}
    {household.recipes.map((copy) => <View key={copy.id} style={styles.recipe}><Text style={styles.label}>{copy.recipe.title}</Text><Text style={styles.help}>{copy.recipe.portions} portions · {copy.recipe.ingredients.map((item) => item.name).join(', ')}</Text>{copy.recipe.steps.map((step, index) => <Text key={index} style={styles.help}>{index + 1}. {step}</Text>)}<Pressable accessibilityRole="button" accessibilityLabel={`Remove copy of ${copy.recipe.title}`} style={styles.button} onPress={() => app.removeHouseholdRecipe(household.id, copy.id)}><Text>Remove copy</Text></Pressable></View>)}
    <Text style={styles.heading}>Copy from personal recipes</Text>
    {!app.recipes.length && <Text style={styles.help}>Save a personal recipe first.</Text>}
    {app.recipes.map((recipe) => {
      const copied = household.recipes.some((copy) => copy.sourceRecipeId === recipe.id);
      return <Pressable key={recipe.id} accessibilityRole="button" accessibilityLabel={`Copy ${recipe.title} to household`} accessibilityState={{ disabled: copied }} disabled={copied} style={styles.button} onPress={() => app.copyRecipeToHousehold(household.id, recipe.id)}><Text>{copied ? 'Copied: ' : 'Copy: '}{recipe.title}</Text></Pressable>;
    })}
  </View>;
}

export default function HouseholdsScreen() {
  const app = useAppState();
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const household = app.households.find((entry) => entry.id === app.activeHouseholdId);
  return <Screen><ScrollView contentContainerStyle={styles.content}>
    <Pressable accessibilityRole="button" accessibilityLabel="Back to Shopping" style={styles.button} onPress={() => router.replace('/shopping')}><Text>← Shopping</Text></Pressable>
    <Text style={styles.title}>Households</Text>
    <Text style={styles.badge}>On this device</Text>
    <Text style={styles.help}>Keep separate shopping lists and selected recipe copies for different households. Device sync, invitations and cross-household sharing are planned. Pantry, chats, provider keys and personal recipes stay personal.</Text>
    <Text style={styles.heading}>Choose a shopping list</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Use personal shopping list" accessibilityState={{ selected: !household }} style={[styles.button, !household && styles.selected]} onPress={() => app.selectHousehold(null)}><Text>Personal list{!household ? ' · Selected' : ''}</Text></Pressable>
    {app.households.map((entry) => <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={`Use ${entry.name} shopping list`} accessibilityState={{ selected: entry.id === app.activeHouseholdId }} style={[styles.button, entry.id === app.activeHouseholdId && styles.selected]} onPress={() => app.selectHousehold(entry.id)}><Text>{entry.name}{entry.id === app.activeHouseholdId ? ' · Selected' : ''}</Text></Pressable>)}
    <Text style={styles.heading}>New household</Text>
    <TextInput accessibilityLabel="Household name" value={name} onChangeText={setName} placeholder="e.g. Home" maxLength={100} style={styles.input} />
    <Pressable accessibilityRole="button" accessibilityLabel="Create household" disabled={!name.trim()} style={styles.button} onPress={() => { try { app.createHousehold(name); setName(''); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create household'); } }}><Text>Create household</Text></Pressable>
    {!!error && <Text style={styles.help}>{error}</Text>}
    {!!household && <HouseholdDetails key={household.id} household={household} />}
  </ScrollView></Screen>;
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12, maxWidth: 720, width: '100%', alignSelf: 'center' },
  title: { fontSize: 32, fontWeight: '800', color: '#172033' },
  heading: { fontSize: 19, fontWeight: '700', color: '#172033', marginTop: 12 },
  label: { fontSize: 16, fontWeight: '600', color: '#172033' },
  badge: { color: '#166534', fontWeight: '700' },
  help: { color: '#475569', lineHeight: 21 },
  card: { padding: 16, gap: 12, backgroundColor: '#ffffff', borderRadius: 16 },
  recipe: { borderBottomWidth: 1, borderBottomColor: '#e2e8f0', paddingVertical: 12, gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { backgroundColor: '#ffffff', color: '#172033', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 12, minHeight: 44, paddingHorizontal: 12 },
  button: { backgroundColor: '#f1f5f9', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 12, minHeight: 44, padding: 12, justifyContent: 'center' },
  selected: { backgroundColor: '#dcfce7', borderColor: '#16a34a' }
});
