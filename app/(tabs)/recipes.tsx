import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/Screen';
import type { Recipe } from '@/domain/types';
import { useAppState } from '@/state/AppState';

export default function RecipesScreen() {
  const router = useRouter();
  const { recipes, deleteRecipe } = useAppState();
  const [selected, setSelected] = useState<Recipe | null>(null);

  return (
    <Screen>
      <View style={styles.header}>
        <View><Text style={styles.eyebrow}>YOUR COOKBOOK</Text><Text style={styles.title}>Saved recipes</Text></View>
        <Pressable onPress={() => router.push('/settings')} style={styles.settings}><Text style={styles.settingsText}>⚙</Text></Pressable>
      </View>

      <FlashList
        data={recipes}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable onPress={() => setSelected(item)} style={styles.card}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              {!!item.description && <Text numberOfLines={2} style={styles.cardDescription}>{item.description}</Text>}
              <Text style={styles.cardMeta}>{item.portions} portions · {item.ingredients.length} ingredients</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
        ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyEmoji}>📖</Text><Text style={styles.emptyTitle}>No saved recipes yet</Text><Text style={styles.emptyText}>Ask Chef to save one when you find something worth making again.</Text></View>}
        contentContainerStyle={{ paddingBottom: 30 }}
      />

      <Modal visible={Boolean(selected)} animationType="slide" onRequestClose={() => setSelected(null)}>
        {selected && (
          <ScrollView contentContainerStyle={styles.recipeDetail}>
            <View style={styles.detailHeader}>
              <Pressable onPress={() => setSelected(null)}><Text style={styles.close}>Close</Text></Pressable>
              <Pressable onPress={() => { deleteRecipe(selected.id); setSelected(null); }}><Text style={styles.delete}>Delete</Text></Pressable>
            </View>
            <Text style={styles.detailTitle}>{selected.title}</Text>
            {!!selected.description && <Text style={styles.detailDescription}>{selected.description}</Text>}
            <Text style={styles.sectionTitle}>Ingredients</Text>
            {selected.ingredients.map((ingredient, index) => (
              <Text key={`${ingredient.name}-${index}`} style={styles.line}>• {ingredient.amount ? `${ingredient.amount} ` : ''}{ingredient.name}{ingredient.needsShopping ? '  🛒' : ''}</Text>
            ))}
            <Text style={styles.sectionTitle}>Method</Text>
            {selected.steps.map((step, index) => <Text key={index} style={styles.step}><Text style={styles.stepNumber}>{index + 1}. </Text>{step}</Text>)}
            {!!selected.notes?.length && <><Text style={styles.sectionTitle}>Notes</Text>{selected.notes.map((note, index) => <Text key={index} style={styles.line}>• {note}</Text>)}</>}
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
  settingsText: { fontSize: 21 },
  card: { marginHorizontal: 16, marginVertical: 6, padding: 17, borderRadius: 18, backgroundColor: 'white', borderWidth: 1, borderColor: '#e2e8f0', flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardTitle: { color: '#172033', fontWeight: '700', fontSize: 18 },
  cardDescription: { color: '#64748b', marginTop: 5, lineHeight: 19 },
  cardMeta: { color: '#94a3b8', fontSize: 12, marginTop: 8, fontWeight: '600' },
  chevron: { color: '#94a3b8', fontSize: 32 },
  empty: { alignItems: 'center', padding: 54 },
  emptyEmoji: { fontSize: 44 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#334155', marginTop: 13 },
  emptyText: { textAlign: 'center', color: '#64748b', lineHeight: 21, marginTop: 8 },
  recipeDetail: { padding: 22, paddingBottom: 60, maxWidth: 760, width: '100%', alignSelf: 'center' },
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  close: { color: '#334155', fontWeight: '700' },
  delete: { color: '#b91c1c', fontWeight: '700' },
  detailTitle: { fontSize: 34, fontWeight: '800', color: '#172033' },
  detailDescription: { marginTop: 8, color: '#64748b', fontSize: 16, lineHeight: 23 },
  sectionTitle: { marginTop: 28, marginBottom: 10, fontSize: 19, fontWeight: '800', color: '#334155' },
  line: { color: '#475569', fontSize: 16, lineHeight: 24, marginBottom: 5 },
  step: { color: '#475569', fontSize: 16, lineHeight: 24, marginBottom: 14 },
  stepNumber: { fontWeight: '800', color: '#172033' }
});
