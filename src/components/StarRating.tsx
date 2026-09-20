import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { IngredientPreference } from '@/domain/types';

export function StarRating({ value, onChange }: { value: IngredientPreference; onChange(value: IngredientPreference): void }) {
  return (
    <View style={styles.row} accessibilityLabel={`Food preference ${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Pressable
          key={star}
          accessibilityRole="button"
          accessibilityLabel={`Set preference to ${star} out of 5`}
          hitSlop={6}
          onPress={() => onChange(star as IngredientPreference)}
          style={styles.button}
        >
          <Text style={[styles.star, star <= value ? styles.active : styles.inactive]}>★</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  button: { paddingHorizontal: 2, paddingVertical: 4 },
  star: { fontSize: 20 },
  active: { color: '#d97706' },
  inactive: { color: '#cbd5e1' }
});
