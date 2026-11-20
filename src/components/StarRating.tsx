import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from '@/theme/StyleSheet';
import type { IngredientPreference } from '@/domain/types';

export function StarRating({ value, onChange }: { value: IngredientPreference; onChange(value: IngredientPreference): void }) {
  return (
    <View style={styles.row} accessibilityLabel={`Food preference ${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Pressable
          key={star}
          accessibilityRole="button"
          accessibilityLabel={`Set preference to ${star} out of 5`}
          accessibilityState={{ selected: star === value }}
          accessibilityHint="Sets how much you want to eat this ingredient"
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
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  button: { paddingHorizontal: 2, paddingVertical: 4 },
  star: { fontSize: 20 },
  active: { color: '#d97706' },
  inactive: { color: '#cbd5e1' }
});
